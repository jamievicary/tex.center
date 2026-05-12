// Unit tests for `cleanupProjectMachine`. Stubs both the
// Machines API client and the assignment store so the test stays
// purely in-process — no Fly, no Postgres.

import assert from "node:assert/strict";

import { cleanupProjectMachine } from "../src/cleanupProjectMachine.ts";

function fakeAssignments(initial) {
  const state = new Map(Object.entries(initial));
  const calls = { get: 0, delete: 0 };
  return {
    state,
    calls,
    async getAssignment(projectId) {
      calls.get += 1;
      const v = state.get(projectId);
      return v ? { machineId: v } : null;
    },
    async deleteAssignment(projectId) {
      calls.delete += 1;
      return state.delete(projectId);
    },
  };
}

function fakeMachines(behaviour) {
  const calls = [];
  return {
    calls,
    async destroyMachine(machineId, opts) {
      calls.push({ machineId, opts });
      if (behaviour === "ok") return;
      if (behaviour === "404") {
        const err = new Error("Fly Machines API 404");
        err.status = 404;
        throw err;
      }
      if (behaviour === "500") {
        const err = new Error("Fly Machines API 500");
        err.status = 500;
        throw err;
      }
      throw new Error(`bad behaviour: ${behaviour}`);
    },
  };
}

// 1. happy path — assignment exists, destroy succeeds, row removed.
{
  const assignments = fakeAssignments({ "proj-1": "machine-aaa" });
  const machines = fakeMachines("ok");
  const result = await cleanupProjectMachine({
    projectId: "proj-1",
    machines,
    assignments,
  });
  assert.deepEqual(result, {
    hadAssignment: true,
    destroyed: true,
    rowDeleted: true,
  });
  assert.deepEqual(machines.calls, [
    { machineId: "machine-aaa", opts: { force: true } },
  ]);
  assert.equal(assignments.state.size, 0);
}

// 2. no assignment — neither destroy nor delete report progress,
//    but the call is still a no-op success.
{
  const assignments = fakeAssignments({});
  const machines = fakeMachines("ok");
  const result = await cleanupProjectMachine({
    projectId: "proj-missing",
    machines,
    assignments,
  });
  assert.deepEqual(result, {
    hadAssignment: false,
    destroyed: false,
    rowDeleted: false,
  });
  assert.equal(machines.calls.length, 0, "no destroy when no assignment");
  assert.equal(assignments.calls.delete, 1, "delete still attempted (idempotent)");
}

// 3. destroy returns 404 — machine already gone is acceptable, row
//    still removed so the next probe gets a clean slate.
{
  const assignments = fakeAssignments({ "proj-2": "machine-bbb" });
  const machines = fakeMachines("404");
  const result = await cleanupProjectMachine({
    projectId: "proj-2",
    machines,
    assignments,
  });
  assert.deepEqual(result, {
    hadAssignment: true,
    destroyed: false,
    rowDeleted: true,
  });
  assert.equal(assignments.state.size, 0);
}

// 4. destroy fails with non-404 — propagate the error and do NOT
//    delete the row, so the next iteration can retry destroy
//    against a live machineId.
{
  const assignments = fakeAssignments({ "proj-3": "machine-ccc" });
  const machines = fakeMachines("500");
  await assert.rejects(
    () =>
      cleanupProjectMachine({
        projectId: "proj-3",
        machines,
        assignments,
      }),
    /500/,
  );
  assert.equal(
    assignments.state.has("proj-3"),
    true,
    "row preserved on destroy failure",
  );
  assert.equal(
    assignments.calls.delete,
    0,
    "deleteAssignment never invoked after destroy throws",
  );
}

console.log("cleanupProjectMachine.test.mjs: PASS");
