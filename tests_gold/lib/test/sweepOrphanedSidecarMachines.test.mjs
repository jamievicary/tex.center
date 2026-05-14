// Unit tests for `sweepOrphanedSidecarMachines`. Pure stubs — no
// Fly, no Postgres.

import assert from "node:assert/strict";

import { sweepOrphanedSidecarMachines } from "../src/sweepOrphanedSidecarMachines.ts";

function machine(id, metadata) {
  return { id, metadata: metadata ?? null };
}

function fakeMachinesIO(initial, destroyBehaviour = () => "ok") {
  const state = new Map(initial.map((m) => [m.id, m]));
  const calls = { list: 0, destroy: [] };
  return {
    state,
    calls,
    async listMachines() {
      calls.list += 1;
      return [...state.values()];
    },
    async destroyMachine(machineId, opts) {
      calls.destroy.push({ machineId, opts });
      const action = destroyBehaviour(machineId);
      if (action === "ok") {
        state.delete(machineId);
        return;
      }
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
  };
}

function fakeProjectIds(ids) {
  return { async getKnownProjectIds() { return new Set(ids); } };
}

// 1. happy path — one orphan, one live, one untagged, one shared-pool.
{
  const io = fakeMachinesIO([
    machine("m-orphan", { texcenter_project: "proj-orphan" }),
    machine("m-live", { texcenter_project: "proj-live" }),
    machine("m-untagged", null),
    machine("m-shared", { fly_process_group: "app" }),
  ]);
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds(["proj-live"]),
  });
  assert.deepEqual(report.destroyed, ["m-orphan"]);
  assert.deepEqual(report.failed, []);
  assert.equal(report.tagged, 2, "only texcenter_project-tagged machines counted");
  assert.equal(report.inspected, 4);
  assert.deepEqual(io.calls.destroy, [
    { machineId: "m-orphan", opts: { force: true } },
  ]);
}

// 2. protectIds — keeps a tagged machine alive even if DB lookup
//    doesn't list it (covers the in-window race where the bootstrap
//    project row was already deleted but its dedicated teardown
//    hasn't reaped the Machine yet).
{
  const io = fakeMachinesIO([
    machine("m-protect", { texcenter_project: "proj-bootstrap" }),
    machine("m-orphan", { texcenter_project: "proj-gone" }),
  ]);
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds([]),
    protectIds: new Set(["proj-bootstrap"]),
  });
  assert.deepEqual(report.destroyed, ["m-orphan"]);
  assert.equal(io.state.has("m-protect"), true, "protected survives");
}

// 3. 404 from destroy — treated as already-gone, counted as destroyed.
{
  const io = fakeMachinesIO(
    [machine("m-gone", { texcenter_project: "proj-x" })],
    () => "404",
  );
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds([]),
  });
  assert.deepEqual(report.destroyed, ["m-gone"]);
  assert.deepEqual(report.failed, []);
}

// 4. non-404 — collected in `failed`, sweep continues for other
//    orphans rather than throwing on the first error.
{
  const io = fakeMachinesIO(
    [
      machine("m-bad", { texcenter_project: "proj-a" }),
      machine("m-good", { texcenter_project: "proj-b" }),
    ],
    (id) => (id === "m-bad" ? "500" : "ok"),
  );
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds([]),
  });
  assert.deepEqual(report.destroyed, ["m-good"]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].machineId, "m-bad");
  assert.equal(report.failed[0].tag, "proj-a");
  assert.match(report.failed[0].error, /500/);
}

// 5. nothing to do — all tagged machines correspond to live projects.
{
  const io = fakeMachinesIO([
    machine("m1", { texcenter_project: "p1" }),
    machine("m2", { texcenter_project: "p2" }),
  ]);
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds(["p1", "p2"]),
  });
  assert.deepEqual(report.destroyed, []);
  assert.deepEqual(report.failed, []);
  assert.equal(report.tagged, 2);
  assert.equal(io.calls.destroy.length, 0);
}

// 6. empty tag string is ignored — defensive against Fly returning
//    `metadata: { texcenter_project: "" }` from a malformed config.
{
  const io = fakeMachinesIO([
    machine("m-empty", { texcenter_project: "" }),
  ]);
  const report = await sweepOrphanedSidecarMachines({
    machines: io,
    projects: fakeProjectIds([]),
  });
  assert.equal(report.tagged, 0);
  assert.deepEqual(report.destroyed, []);
}

console.log("sweepOrphanedSidecarMachines.test.mjs: PASS");
