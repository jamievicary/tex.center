// Unit tests for the `deleteProject` server helper used by the
// `/projects` dashboard's `?/delete` form action.
//
// Since M13.2(b).2 (iter 254) the helper is **optimistic**: the DB
// row is deleted first, then Fly `destroyMachine` runs as a
// fire-and-forget background task whose completion is exposed on
// `result.destroyComplete`. These tests await that promise so the
// assertions stay deterministic.

import assert from "node:assert/strict";

import { deleteProject } from "../src/lib/server/deleteProject.ts";
import { FlyApiError } from "../src/lib/server/flyMachines.ts";

const MACHINE_ID = "mach-xyz";

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
    assert.equal(result.rowDeleted, true);
    const bg = await result.destroyComplete;
    assert.equal(bg.destroyed, false);
    assert.equal(bg.error, undefined);
    assert.equal(
      machinesClientCalled,
      false,
      "no assignment → no MachinesClient construction",
    );
    assert.equal(await getProjectById(db, proj.id), null);
  }

  // --- assignment present: row gone immediately; destroy runs --
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
    assert.equal(result.rowDeleted, true);
    // Row + cascade must already be gone before destroyComplete
    // settles — that is the whole point of the optimistic ordering.
    assert.equal(await getProjectById(db, proj.id), null);
    assert.equal(await getMachineAssignmentByProjectId(db, proj.id), null);
    const bg = await result.destroyComplete;
    assert.equal(bg.destroyed, true);
    assert.equal(bg.error, undefined);
    assert.deepEqual(calls, [{ id: MACHINE_ID, opts: { force: true } }]);
  }

  // --- optimism: helper resolves *before* destroyMachine settles --
  {
    const proj = await createProject(db, {
      ownerId: owner.id,
      name: "slow-destroy",
    });
    await upsertMachineAssignment(db, {
      projectId: proj.id,
      machineId: "slow-id",
      region: "fra",
      state: "started",
    });
    let destroyResolve = () => {};
    const destroyGate = new Promise((res) => {
      destroyResolve = res;
    });
    let destroyEntered = false;
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => ({
        destroyMachine: async () => {
          destroyEntered = true;
          await destroyGate;
        },
      }),
    });
    // The helper has returned: row is gone, but the destroy is
    // still suspended on `destroyGate`.
    assert.equal(result.rowDeleted, true);
    assert.equal(await getProjectById(db, proj.id), null);
    assert.equal(destroyEntered, true, "destroyMachine was kicked off");
    // destroyComplete must not be settled yet.
    let settled = false;
    void result.destroyComplete.then(() => {
      settled = true;
    });
    // Drain microtasks; the gate is still closed so the promise
    // must remain pending.
    await new Promise((r) => setImmediate(r));
    assert.equal(
      settled,
      false,
      "destroyComplete must still be pending while destroy is in-flight",
    );
    destroyResolve();
    const bg = await result.destroyComplete;
    assert.equal(bg.destroyed, true);
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
    const errors = [];
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => ({
        destroyMachine: async () => {
          throw new FlyApiError(404, "https://example/x", { error: "gone" });
        },
      }),
      logError: (msg, err) => errors.push({ msg, err }),
    });
    assert.equal(result.hadAssignment, true);
    assert.equal(result.rowDeleted, true);
    const bg = await result.destroyComplete;
    assert.equal(
      bg.destroyed,
      false,
      "404 → destroyed stays false (no successful destroy)",
    );
    assert.equal(bg.error, undefined);
    assert.equal(errors.length, 0, "404 is not logged as an error");
    assert.equal(await getProjectById(db, proj.id), null);
    assert.equal(await getMachineAssignmentByProjectId(db, proj.id), null);
  }

  // --- non-404 destroy errors: logged, row still deleted ---------
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
    const errors = [];
    const result = await deleteProject({
      db,
      projectId: proj.id,
      env: { FLY_API_TOKEN: "tok", SIDECAR_APP_NAME: "app" },
      makeMachinesClient: () => ({
        destroyMachine: async () => {
          throw new FlyApiError(500, "https://example/x", { error: "boom" });
        },
      }),
      logError: (msg, err) => errors.push({ msg, err }),
    });
    // Optimistic: row IS deleted even though the background destroy
    // failed; the orphan-tag sweep is the safety net.
    assert.equal(result.rowDeleted, true);
    assert.equal(await getProjectById(db, proj.id), null);
    const bg = await result.destroyComplete;
    assert.equal(bg.destroyed, false);
    assert.ok(
      bg.error instanceof FlyApiError && bg.error.status === 500,
      "non-404 propagated on the destroyComplete payload",
    );
    assert.equal(
      errors.length,
      1,
      "non-404 destroy failure must be logged exactly once",
    );
    assert.ok(
      errors[0].err instanceof FlyApiError && errors[0].err.status === 500,
      "logged error carries the FlyApiError",
    );
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
    assert.equal(result.rowDeleted, true);
    const bg = await result.destroyComplete;
    assert.equal(bg.destroyed, false);
    assert.equal(await getProjectById(db, proj.id), null);
  }

  console.log("deleteProject.test.mjs: PASS");
} finally {
  await pg.close();
}
