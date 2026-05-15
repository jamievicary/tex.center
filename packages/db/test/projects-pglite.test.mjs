// Integration test for `createProject`, `getProjectById`,
// `listProjectsByOwnerId` against the in-process PGlite engine.
// Same pattern as users-sessions-pglite.test.mjs.

import assert from 'node:assert/strict';

import { drizzle } from 'drizzle-orm/pglite';

import {
  createProject,
  deleteProject,
  findOrCreateUserByGoogleSub,
  getProjectById,
  getProjectSeedDoc,
  upsertMachineAssignment,
  getMachineAssignmentByProjectId,
  listAllProjectIds,
  listProjectsByOwnerId,
  schema,
} from '../src/index.ts';

import { freshMigratedPglite } from './_pgliteHarness.mjs';

const { pg } = await freshMigratedPglite();
try {
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
  assert.equal(p1b.seedDoc, null, 'seed_doc defaults to null when not supplied');
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

  // --- deleteProject: cascades machine_assignments, idempotent ---
  const victim = await createProject(db, {
    ownerId: owner.id,
    name: 'To delete',
  });
  await upsertMachineAssignment(db, {
    projectId: victim.id,
    machineId: 'mach-xyz',
    region: 'fra',
    state: 'started',
  });
  const maBefore = await getMachineAssignmentByProjectId(db, victim.id);
  assert.ok(maBefore, 'precondition: assignment row exists before delete');

  const removed = await deleteProject(db, victim.id);
  assert.equal(removed, true, 'deleteProject returns true on hit');
  const victimGone = await getProjectById(db, victim.id);
  assert.equal(victimGone, null, 'projects row gone after deleteProject');
  const maAfter = await getMachineAssignmentByProjectId(db, victim.id);
  assert.equal(
    maAfter,
    null,
    'machine_assignments cascade-deletes with projects row',
  );

  // Idempotent on a missing row.
  const removedAgain = await deleteProject(db, victim.id);
  assert.equal(
    removedAgain,
    false,
    'deleteProject returns false when no row matches',
  );

  // --- listAllProjectIds: union of all rows, regardless of owner -
  const allIds = new Set(await listAllProjectIds(db));
  // p1, p2 (owner), pOther (other) survive; `victim` was deleted.
  assert.equal(allIds.has(p1.id), true, 'p1 in listAllProjectIds');
  assert.equal(allIds.has(p2.id), true, 'p2 in listAllProjectIds');
  assert.equal(allIds.has(pOther.id), true, 'pOther in listAllProjectIds');
  assert.equal(allIds.has(victim.id), false, 'deleted row absent from listAllProjectIds');
  assert.equal(allIds.size, 3, 'exactly the surviving rows');

  // --- seedMainDoc round-trip (M15 Step D) -----------------------
  // Placed at the end so the new row doesn't perturb the
  // listProjectsByOwnerId / listAllProjectIds ordering above.
  const TWO_PAGE_SEED =
    '\\documentclass{article}\n' +
    '\\begin{document}\n' +
    'Page one.\n' +
    '\\newpage\n' +
    'Page two.\n' +
    '\\end{document}\n';
  const seeded = await createProject(db, {
    ownerId: owner.id,
    name: 'Seeded',
    seedMainDoc: TWO_PAGE_SEED,
  });
  assert.equal(seeded.seedDoc, TWO_PAGE_SEED, 'returning row carries seed_doc');
  assert.equal(
    await getProjectSeedDoc(db, seeded.id),
    TWO_PAGE_SEED,
    'getProjectSeedDoc returns the seed bytes verbatim',
  );
  assert.equal(
    await getProjectSeedDoc(db, p1.id),
    null,
    'getProjectSeedDoc returns null when not seeded',
  );
  assert.equal(
    await getProjectSeedDoc(db, '00000000-0000-0000-0000-000000000000'),
    null,
    'getProjectSeedDoc returns null for unknown project',
  );

  console.log('projects PGlite test: OK');
} finally {
  await pg.close();
}
