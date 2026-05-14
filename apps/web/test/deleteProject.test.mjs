// Unit tests for the `deleteProject` server helper used by the
// `/projects` dashboard's `?/delete` form action.
//
// The helper composes (a) Fly Machine destroy (best-effort via
// `MachinesClient.destroyMachine`) and (b) `db.deleteProject` (which
// cascades the `machine_assignments` row through the FK). These
// tests stub both sides so the assertions stay deterministic.

import assert from "node:assert/strict";

import { deleteProject } from "../src/lib/server/deleteProject.ts";
import { FlyApiError } from "../src/lib/server/flyMachines.ts";

const PROJECT_ID = "proj-abc";
const MACHINE_ID = "mach-xyz";

function makeStubDb(opts) {
  const calls = { deletes: 0 };
  const lookups = opts.assignments ?? new Map();
  const projectsDeleted = opts.projectsDeleted ?? new Set();
  // Minimal duck of DrizzleDb shape used by getMachineAssignmentByProjectId +
  // deleteProject. We don't actually thread real drizzle; instead we
  // monkey-patch via module mocks below — but here we just return an
  // object whose own methods will be called by our stub layer.
  return {
    __stub: true,
    assignments: lookups,
    projectsDeleted,
    calls,
  };
}

// Patch the @tex-center/db exports the helper reaches for, by
// shadowing via the import map: we re-import the helper with a
// hand-rolled wrapper. Simplest approach: import the helper, then
// pass a `makeMachinesClient` injection point + use a fake `db` and
// stub the two db functions via Node module loader hooks. To stay
// dependency-free, instead exercise the helper through the public
// surface by stubbing the global `fetch` (MachinesClient uses
// `fetch`) and using a real in-memory db via PGlite.

// Pragmatic approach: re-implement the helper's dependencies
// (getMachineAssignmentByProjectId, deleteProject) via a thin
// passthrough using PGlite + drizzle, so this becomes a true
// integration of the helper against its real db layer.

import { drizzle } from "drizzle-orm/pglite";

import {
  createProject,
  findOrCreateUserByGoogleSub,
  getProjectById,
  upsertMachineAssignment,
  getMachineAssignmentByProjectId,
  schema,
} from "@tex-center/db";

import { freshMigratedPglite } from "../../../packages/db/test/_pgliteHarness.mjs";

const { pg } = await freshMigratedPglite();
try {
  const db = /** @type {any} */ (drizzle(pg, { schema }));
  const owner = await findOrCreateUserByGoogleSub(db, {
    googleSub: "sub-owner",
    email: "owner@example.com",
  });

  // --- no assignment: skips Fly call entirely, deletes row -------
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "no-assignment",
    });
    let machinesClientCalled = false;
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => {
        machinesClientCalled = true;
        return {
          destroyMachine: async () => {
            throw new Error("must not be called");
          },
        };
      },
    });
    assert.equal(result.hadAssignment, false);
    assert.equal(result.machineDestroyed, false);
    assert.equal(result.rowDeleted, true);
    assert.equal(
      machinesClientCalled,
      false,
      "no assignment → no MachinesClient construction",
    );
    assert.equal(await getProjectById(db, proj.id), null);
  }

  // --- assignment present: destroys machine, cascades MA row -----
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "with-assignment",
    });
    await upsertMachineAssignment(db, {
      projectId: proj.id,
      machineId: MACHINE_ID,
      region: "fra",
      state: "started",
    });
    const calls = [];
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => ({
        destroyMachine: async (id, opts) => {
          calls.push({ id, opts });
        },
      }),
    });
    assert.equal(result.hadAssignment, true);
    assert.equal(result.machineDestroyed, true);
    assert.equal(result.rowDeleted, true);
    assert.deepEqual(calls, [{ id: MACHINE_ID, opts: { force: true } }]);
    assert.equal(await getProjectById(db, proj.id), null);
    assert.equal(await getMachineAssignmentByProjectId(db, proj.id), null);
  }

  // --- 404 from destroy is swallowed (already gone) --------------
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "already-gone",
    });
    await upsertMachineAssignment(db, {
      projectId: proj.id,
      machineId: "ghost",
      region: "fra",
      state: "destroyed",
    });
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => ({
        destroyMachine: async () => {
          throw new FlyApiError(404, "https://example/x", { error: "gone" });
        },
      }),
    });
    assert.equal(result.hadAssignment, true);
    assert.equal(
      result.machineDestroyed,
      false,
      "404 → machineDestroyed stays false (no successful destroy)",
    );
    assert.equal(result.rowDeleted, true);
    assert.equal(await getProjectById(db, proj.id), null);
    assert.equal(await getMachineAssignmentByProjectId(db, proj.id), null);
  }

  // --- non-404 destroy errors propagate, row NOT deleted ---------
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "destroy-error",
    });
    await upsertMachineAssignment(db, {
      projectId: proj.id,
      machineId: "boom",
      region: "fra",
      state: "started",
    });
    let caught;
    try {
      await deleteProject({
        db,
        projectId: proj.id,
        env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
        makeMachinesClient: () => ({
          destroyMachine: async () => {
            throw new FlyApiError(500, "https://example/x", { error: "boom" });
          },
        }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "non-404 destroy error must propagate");
    assert.ok(
      caught instanceof FlyApiError && caught.status === 500,
      "propagated error is the FlyApiError",
    );
    // Row must still be present so the user can retry; cascade not
    // fired.
    const stillThere = await getProjectById(db, proj.id);
    assert.ok(stillThere, "projects row preserved on destroy failure");
  }

  // --- env unset: Fly destroy is skipped, row still deleted ------
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "no-env",
    });
    await upsertMachineAssignment(db, {
      projectId: proj.id,
      machineId: "skipped",
      region: "fra",
      state: "started",
    });
    let constructed = false;
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: {},
      makeMachinesClient: () => {
        constructed = true;
        return {
          destroyMachine: async () => {
            throw new Error("must not be called");
          },
        };
      },
    });
    assert.equal(constructed, false, "no token/app → no client built");
    assert.equal(result.hadAssignment, true);
    assert.equal(result.machineDestroyed, false);
    assert.equal(result.rowDeleted, true);
    assert.equal(await getProjectById(db, proj.id), null);
  }

  console.log("deleteProject.test.mjs: PASS");
} finally {
  await pg.close();
}
