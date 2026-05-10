// Integration test for `findOrCreateUserByGoogleSub` and
// `insertSession` against the in-process PGlite engine. Real
// migrations are applied first so the helpers run against the
// same DDL that prod will.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

import {
  applyMigrations,
  findOrCreateUserByGoogleSub,
  getSessionWithUser,
  insertSession,
  loadMigrations,
  MIGRATIONS_TABLE_SQL,
  schema,
  sessions,
  users,
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
  // PGlite's drizzle adapter has a different concrete class than
  // postgres-js's, but the query-builder surface is identical. The
  // cast keeps the prod helper strongly typed.
  const db = /** @type {any} */ (drizzle(pg, { schema }));

  // --- findOrCreateUserByGoogleSub: fresh insert -----------------
  const created = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-A',
    email: 'a@example.com',
    displayName: 'A',
  });
  assert.equal(created.googleSub, 'google-sub-A');
  assert.equal(created.email, 'a@example.com');
  assert.equal(created.displayName, 'A');
  assert.ok(created.id);
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.updatedAt instanceof Date);

  // --- second call with same sub: returns same row id, refreshes email/name
  // updated_at must move forward — sleep at least 1ms.
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-A',
    email: 'a-new@example.com',
    displayName: 'A New',
  });
  assert.equal(refreshed.id, created.id, 'same google_sub → same row id');
  assert.equal(refreshed.email, 'a-new@example.com');
  assert.equal(refreshed.displayName, 'A New');
  assert.ok(
    refreshed.updatedAt.getTime() >= created.updatedAt.getTime(),
    'updated_at must not move backwards',
  );

  // --- different google_sub: new row -----------------------------
  const other = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-B',
    email: 'b@example.com',
  });
  assert.notEqual(other.id, created.id);
  assert.equal(other.displayName, null);

  // exactly two user rows total
  const allUsers = await db.select().from(users);
  assert.equal(allUsers.length, 2);

  // --- insertSession ---------------------------------------------
  const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await insertSession(db, {
    userId: created.id,
    expiresAt: exp,
  });
  assert.ok(session.id);
  assert.equal(session.userId, created.id);
  assert.equal(session.expiresAt.getTime(), exp.getTime());
  assert.ok(session.createdAt instanceof Date);

  // sanity: row is actually queryable by id
  const rows = await db.select().from(sessions).where(eq(sessions.id, session.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, created.id);

  // FK enforcement: insertSession against a non-existent userId throws.
  let fkErr;
  try {
    await insertSession(db, {
      userId: '00000000-0000-0000-0000-000000000000',
      expiresAt: exp,
    });
  } catch (e) {
    fkErr = e;
  }
  assert.ok(fkErr, 'insertSession with bad userId must throw (FK)');

  // --- getSessionWithUser: happy path ----------------------------
  const lookup = await getSessionWithUser(db, session.id);
  assert.ok(lookup, 'session must be found by id');
  assert.equal(lookup.session.id, session.id);
  assert.equal(lookup.session.userId, created.id);
  assert.equal(lookup.user.id, created.id);
  assert.equal(lookup.user.email, refreshed.email);
  assert.equal(lookup.user.googleSub, 'google-sub-A');

  // --- getSessionWithUser: unknown sid → null --------------------
  const miss = await getSessionWithUser(
    db,
    '11111111-1111-1111-1111-111111111111',
  );
  assert.equal(miss, null);

  console.log('users + sessions PGlite test: OK');
} finally {
  await pg.close();
}
