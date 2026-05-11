// Integration test for `createProject`, `getProjectById`,
// `listProjectsByOwnerId` against the in-process PGlite engine.
// Same pattern as users-sessions-pglite.test.mjs.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import {
  applyMigrations,
  createProject,
  findOrCreateUserByGoogleSub,
  getProjectById,
  listProjectsByOwnerId,
  loadMigrations,
  MIGRATIONS_TABLE_SQL,
  schema,
} from '../src/index.ts';

function pgliteDriver(pg) {
  return {
    async ensureMigrationsTable() {
      await pg.exec(MIGRATIONS_TABLE_SQL);
    },
    async loadAppliedRows() {
      const res = await pg.query('SELECT name, sha256 FROM schema_migrations');
      return res.rows;
    },
    async applyOne(m) {
      await pg.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.query(
          'INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)',
          [m.name, m.sha256],
        );
      });
    },
  };
}

const migrationsDir = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const migrations = await loadMigrations(migrationsDir);

const pg = new PGlite();
try {
  await applyMigrations(pgliteDriver(pg), migrations);
  const db = /** @type {any} */ (drizzle(pg, { schema }));

  const owner = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'sub-owner',
    email: 'owner@example.com',
  });
  const other = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'sub-other',
    email: 'other@example.com',
  });

  // --- createProject: returns full row with timestamps -----------
  const p1 = await createProject(db, { ownerId: owner.id, name: 'Thesis' });
  assert.ok(p1.id);
  assert.equal(p1.ownerId, owner.id);
  assert.equal(p1.name, 'Thesis');
  assert.ok(p1.createdAt instanceof Date);
  assert.ok(p1.updatedAt instanceof Date);

  // --- getProjectById: hit + miss --------------------------------
  const p1b = await getProjectById(db, p1.id);
  assert.ok(p1b);
  assert.equal(p1b.id, p1.id);
  assert.equal(p1b.name, 'Thesis');
  const miss = await getProjectById(
    db,
    '00000000-0000-0000-0000-000000000000',
  );
  assert.equal(miss, null);

  // --- listProjectsByOwnerId: ordering + isolation --------------
  // Insert a second project for owner; small sleep so created_at
  // differs from p1 even on a coarse clock.
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await createProject(db, { ownerId: owner.id, name: 'Paper A' });
  // Project for the other user — must not appear in owner's list.
  const pOther = await createProject(db, {
    ownerId: other.id,
    name: 'Other Paper',
  });

  const ownerList = await listProjectsByOwnerId(db, owner.id);
  assert.equal(ownerList.length, 2);
  assert.equal(ownerList[0].id, p1.id, 'older project listed first');
  assert.equal(ownerList[1].id, p2.id);
  // None of the rows should belong to the other owner.
  for (const row of ownerList) {
    assert.equal(row.ownerId, owner.id);
  }

  const otherList = await listProjectsByOwnerId(db, other.id);
  assert.equal(otherList.length, 1);
  assert.equal(otherList[0].id, pOther.id);

  // Empty list for an unknown owner.
  const empty = await listProjectsByOwnerId(
    db,
    '11111111-1111-1111-1111-111111111111',
  );
  assert.equal(empty.length, 0);

  // --- FK enforcement: ownerId must reference users.id ----------
  let fkErr;
  try {
    await createProject(db, {
      ownerId: '22222222-2222-2222-2222-222222222222',
      name: 'Orphan',
    });
  } catch (e) {
    fkErr = e;
  }
  assert.ok(fkErr, 'createProject with bad ownerId must throw (FK)');

  console.log('projects PGlite test: OK');
} finally {
  await pg.close();
}
