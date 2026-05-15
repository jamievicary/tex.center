// Unit tests for `cleanupOldPlaywrightProjects`. Pure stubs — no
// Fly, no Postgres. Same shape as
// `cleanupProjectMachine.test.mjs` + `sweepOrphanedSidecarMachines
// .test.mjs`.

import assert from "node:assert/strict";

import {
  cleanupOldPlaywrightProjects,
} from "../src/cleanupOldPlaywrightProjects.ts";

function makeFakes({ assignments, destroyBehaviour, deleteRowBehaviour } = {}) {
  const assignmentState = new Map(
    Object.entries(assignments ?? {}).map(([pid, mid]) => [pid, { machineId: mid }]),
  );
  const calls = { destroy: [], deleteRow: [], lookup: [] };

  const stores = {
    assignments: {
      async getAssignment(pid) {
        calls.lookup.push(pid);
        return assignmentState.get(pid) ?? null;
      },
      async deleteAssignment(pid) {
        const had = assignmentState.delete(pid);
        return had;
      },
    },
    machines: {
      async destroyMachine(machineId, opts) {
        calls.destroy.push({ machineId, opts });
        const action = destroyBehaviour?.(machineId) ?? "ok";
        if (action === "ok") return;
        if (action === "404") {
          const err = new Error("Fly Machines API 404");
          err.status = 404;
          throw err;
        }
        if (action === "500") {
          const err = new Error("Fly Machines API 500");
          err.status = 500;
          throw err;
        }
        throw new Error(`bad action: ${action}`);
      },
    },
    rows: {
      async deleteProject(pid) {
        calls.deleteRow.push(pid);
        const action = deleteRowBehaviour?.(pid) ?? "ok";
        if (action === "ok") return true;
        if (action === "missing") return false;
        if (action === "throw") throw new Error("delete row failed");
        throw new Error(`bad action: ${action}`);
      },
    },
  };
  return { stores, calls };
}

function pwProject(id, name = `pw-${id}`) {
  return { id, name, createdAt: new Date("2026-05-01T00:00:00Z") };
}

// 1. happy path — assignment row + destroy + delete row for every input.
{
  const projects = [pwProject("p1"), pwProject("p2"), pwProject("p3")];
  const { stores, calls } = makeFakes({
    assignments: { p1: "m1", p2: "m2", p3: "m3" },
  });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.equal(report.inspected, 3);
  assert.deepEqual(report.machinesDestroyed, ["p1", "p2", "p3"]);
  assert.deepEqual(report.rowsDeleted, ["p1", "p2", "p3"]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(calls.destroy.map((c) => c.machineId), ["m1", "m2", "m3"]);
  for (const c of calls.destroy) {
    assert.deepEqual(c.opts, { force: true }, "destroy is always force=true");
  }
  assert.deepEqual(calls.deleteRow, ["p1", "p2", "p3"]);
}

// 2. no assignment row — skip destroy, still delete project row.
//    (leak shape (b): Fly auto-stopped the Machine, DB rows stayed.)
{
  const projects = [pwProject("orphan-row-only")];
  const { stores, calls } = makeFakes({ assignments: {} });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.deepEqual(report.machinesDestroyed, []);
  assert.deepEqual(report.rowsDeleted, ["orphan-row-only"]);
  assert.deepEqual(report.failed, []);
  assert.equal(calls.destroy.length, 0, "no destroy call when no assignment");
  assert.deepEqual(calls.deleteRow, ["orphan-row-only"]);
}

// 3. destroy returns 404 — treated as already-gone, row still deleted.
{
  const projects = [pwProject("p404")];
  const { stores, calls } = makeFakes({
    assignments: { p404: "m404" },
    destroyBehaviour: () => "404",
  });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.deepEqual(report.machinesDestroyed, ["p404"]);
  assert.deepEqual(report.rowsDeleted, ["p404"]);
  assert.deepEqual(report.failed, []);
  assert.equal(calls.deleteRow.length, 1);
}

// 4. destroy 500 — recorded in `failed`, project row NOT deleted, loop
//    continues to the next entry.
{
  const projects = [pwProject("p-bad"), pwProject("p-good")];
  const { stores, calls } = makeFakes({
    assignments: { "p-bad": "m-bad", "p-good": "m-good" },
    destroyBehaviour: (id) => (id === "m-bad" ? "500" : "ok"),
  });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.deepEqual(report.machinesDestroyed, ["p-good"]);
  assert.deepEqual(report.rowsDeleted, ["p-good"]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].projectId, "p-bad");
  assert.equal(report.failed[0].stage, "destroy");
  assert.match(report.failed[0].error, /500/);
  assert.equal(calls.deleteRow.length, 1, "row delete skipped for failed destroy");
  assert.deepEqual(calls.deleteRow, ["p-good"]);
}

// 5. deleteProject returns false (row already gone) — not a failure.
{
  const projects = [pwProject("p-missing")];
  const { stores } = makeFakes({
    assignments: {},
    deleteRowBehaviour: () => "missing",
  });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.deepEqual(report.machinesDestroyed, []);
  assert.deepEqual(report.rowsDeleted, [], "no row deleted but no failure recorded");
  assert.deepEqual(report.failed, []);
}

// 6. deleteProject throws — recorded in `failed`, loop continues.
{
  const projects = [pwProject("p-throws"), pwProject("p-ok")];
  const { stores } = makeFakes({
    assignments: {},
    deleteRowBehaviour: (pid) => (pid === "p-throws" ? "throw" : "ok"),
  });
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.deepEqual(report.rowsDeleted, ["p-ok"]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].projectId, "p-throws");
  assert.equal(report.failed[0].stage, "deleteRow");
}

// 7. assignments.getAssignment throws — recorded as "lookup", loop continues.
{
  const projects = [pwProject("p-lookup-throws"), pwProject("p-ok2")];
  const stores = {
    assignments: {
      async getAssignment(pid) {
        if (pid === "p-lookup-throws") throw new Error("db down");
        return null;
      },
      async deleteAssignment() { return true; },
    },
    machines: {
      async destroyMachine() {
        throw new Error("destroyMachine should not be called for lookup failure");
      },
    },
    rows: { async deleteProject() { return true; } },
  };
  const report = await cleanupOldPlaywrightProjects({ projects, ...stores });
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].projectId, "p-lookup-throws");
  assert.equal(report.failed[0].stage, "lookup");
  assert.deepEqual(report.rowsDeleted, ["p-ok2"]);
}

// 8. empty input — no-op.
{
  const { stores } = makeFakes({});
  const report = await cleanupOldPlaywrightProjects({ projects: [], ...stores });
  assert.deepEqual(report, {
    inspected: 0,
    machinesDestroyed: [],
    rowsDeleted: [],
    failed: [],
  });
}

console.log("cleanupOldPlaywrightProjects.test.mjs: PASS");
