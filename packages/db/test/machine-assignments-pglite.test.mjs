// Integration test for the machine_assignments storage
// primitives against the in-process PGlite engine.

import assert from 'node:assert/strict';

import { drizzle } from 'drizzle-orm/pglite';

import {
  createProject,
  deleteMachineAssignment,
  findOrCreateUserByGoogleSub,
  getMachineAssignmentByProjectId,
  schema,
  updateMachineAssignmentState,
  upsertMachineAssignment,
} from '../src/index.ts';

import { freshMigratedPglite } from './_pgliteHarness.mjs';

const { pg } = await freshMigratedPglite();
try {
  const db = /** @type {any} */ (drizzle(pg, { schema }));

  const owner = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'sub-ma',
    email: 'ma@example.com',
  });
  const proj = await createProject(db, {
    ownerId: owner.id,
    name: 'Project A',
  });

  // --- miss before insert ----------------------------------------
  const miss = await getMachineAssignmentByProjectId(db, proj.id);
  assert.equal(miss, null);

  // --- insert via upsert -----------------------------------------
  const inserted = await upsertMachineAssignment(db, {
    projectId: proj.id,
    machineId: 'm-1111',
    region: 'fra',
    state: 'starting',
  });
  assert.equal(inserted.projectId, proj.id);
  assert.equal(inserted.machineId, 'm-1111');
  assert.equal(inserted.region, 'fra');
  assert.equal(inserted.state, 'starting');
  assert.ok(inserted.lastSeenAt instanceof Date);
  assert.ok(inserted.createdAt instanceof Date);

  // --- get returns the row ---------------------------------------
  const hit = await getMachineAssignmentByProjectId(db, proj.id);
  assert.ok(hit);
  assert.equal(hit.machineId, 'm-1111');

  // --- upsert on existing project_id updates in place ------------
  await new Promise((r) => setTimeout(r, 5));
  const updated = await upsertMachineAssignment(db, {
    projectId: proj.id,
    machineId: 'm-2222',
    region: 'fra',
    state: 'running',
  });
  assert.equal(updated.projectId, proj.id);
  assert.equal(updated.machineId, 'm-2222');
  assert.equal(updated.state, 'running');
  assert.ok(
    updated.lastSeenAt.getTime() >= inserted.lastSeenAt.getTime(),
    'lastSeenAt advances on upsert',
  );
  // createdAt is preserved across upsert.
  assert.equal(
    updated.createdAt.getTime(),
    inserted.createdAt.getTime(),
    'createdAt preserved across upsert',
  );

  // Still exactly one row for this project.
  const reread = await getMachineAssignmentByProjectId(db, proj.id);
  assert.ok(reread);
  assert.equal(reread.machineId, 'm-2222');

  // --- updateMachineAssignmentState ------------------------------
  await new Promise((r) => setTimeout(r, 5));
  const stopped = await updateMachineAssignmentState(db, proj.id, 'stopped');
  assert.ok(stopped);
  assert.equal(stopped.state, 'stopped');
  assert.ok(
    stopped.lastSeenAt.getTime() >= updated.lastSeenAt.getTime(),
    'state update advances lastSeenAt',
  );

  // updateMachineAssignmentState on missing project_id returns null.
  const noUpdate = await updateMachineAssignmentState(
    db,
    '00000000-0000-0000-0000-000000000000',
    'running',
  );
  assert.equal(noUpdate, null);

  // --- FK enforcement: project_id must reference projects.id -----
  let fkErr;
  try {
    await upsertMachineAssignment(db, {
      projectId: '11111111-1111-1111-1111-111111111111',
      machineId: 'm-3',
      region: 'fra',
      state: 'starting',
    });
  } catch (e) {
    fkErr = e;
  }
  assert.ok(fkErr, 'upsert with unknown project_id must throw (FK)');

  // --- deleteMachineAssignment -----------------------------------
  const removed = await deleteMachineAssignment(db, proj.id);
  assert.equal(removed, true);
  const afterDelete = await getMachineAssignmentByProjectId(db, proj.id);
  assert.equal(afterDelete, null);
  const removedAgain = await deleteMachineAssignment(db, proj.id);
  assert.equal(removedAgain, false);

  // --- cascade on project delete --------------------------------
  // Re-mint, then delete the project; the assignment row must
  // disappear via ON DELETE CASCADE.
  await upsertMachineAssignment(db, {
    projectId: proj.id,
    machineId: 'm-9999',
    region: 'fra',
    state: 'starting',
  });
  await pg.query('DELETE FROM projects WHERE id = $1', [proj.id]);
  const afterCascade = await getMachineAssignmentByProjectId(db, proj.id);
  assert.equal(afterCascade, null, 'cascade-on-delete removes assignment');

  console.log('machine_assignments PGlite test: OK');
} finally {
  await pg.close();
}
