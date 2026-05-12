// Unit tests for the per-project upstream resolver (M7.1.2).
//
// Exercises the state machine with a fake `MachinesClient` and an
// in-memory `MachineAssignmentStore`. The real db adapter
// (`dbMachineAssignmentStore`) is covered indirectly by the
// PGlite integration test for the storage primitives.

import assert from "node:assert/strict";

import {
  cachedStateOf,
  createUpstreamResolver,
} from "../src/lib/server/upstreamResolver.ts";

// ---- cachedStateOf ----

assert.equal(cachedStateOf("started"), "running");
assert.equal(cachedStateOf("stopped"), "stopped");
assert.equal(cachedStateOf("suspended"), "stopped");
assert.equal(cachedStateOf("starting"), "starting");
assert.equal(cachedStateOf("created"), "starting");
assert.equal(cachedStateOf("stopping"), "starting");

// ---- helpers ----

function makeStore() {
  const rows = new Map();
  return {
    rows,
    async get(projectId) {
      return rows.get(projectId) ?? null;
    },
    async upsert(input) {
      rows.set(input.projectId, {
        machineId: input.machineId,
        region: input.region,
        state: input.state,
      });
    },
    async updateState(projectId, state) {
      const r = rows.get(projectId);
      if (r) rows.set(projectId, { ...r, state });
    },
    async delete(projectId) {
      rows.delete(projectId);
    },
  };
}

function makeMachinesStub({ initial = [], onCreate, onStart } = {}) {
  // initial: list of { id, state, region? } pre-existing machines.
  const machines = new Map();
  for (const m of initial) machines.set(m.id, { ...m });
  const calls = [];
  let nextId = 1;
  return {
    machines,
    calls,
    appName: "test-app",
    async createMachine(req) {
      const id = `m-${nextId++}`;
      const state = onCreate?.(req) ?? "started";
      const m = { id, state, region: req.region };
      machines.set(id, m);
      calls.push({ kind: "create", id, state });
      return m;
    },
    async getMachine(id) {
      const m = machines.get(id);
      if (!m) {
        const err = new Error(`no such machine ${id}`);
        err.status = 404;
        throw err;
      }
      calls.push({ kind: "get", id, state: m.state });
      return { ...m };
    },
    async startMachine(id) {
      const m = machines.get(id);
      if (!m) throw new Error(`startMachine: no such machine ${id}`);
      const next = onStart?.(id) ?? "started";
      m.state = next;
      calls.push({ kind: "start", id, state: next });
    },
    async waitForState(id, state) {
      const m = machines.get(id);
      if (!m) throw new Error(`waitForState: no such machine ${id}`);
      // Pretend we observed the transition.
      m.state = state;
      calls.push({ kind: "wait", id, state });
    },
    internalAddress(id) {
      return `${id}.vm.${this.appName}.internal`;
    },
  };
}

const baseOpts = {
  sidecarPort: 3001,
  sidecarRegion: "fra",
  machineConfig: { image: "registry.example/sidecar:latest" },
};

// ---- case 1: missing row → createMachine, started immediately ----

{
  const store = makeStore();
  const machines = makeMachinesStub({
    onCreate: () => "started",
  });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });

  const upstream = await resolve("p1");
  assert.equal(upstream.port, 3001);
  assert.match(upstream.host, /^m-1\.vm\.test-app\.internal$/);

  const row = store.rows.get("p1");
  assert.ok(row, "row should exist after resolve");
  assert.equal(row.machineId, "m-1");
  assert.equal(row.region, "fra");
  assert.equal(row.state, "running"); // updateState ran at end

  const kinds = machines.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ["create", "get"]);
}

// ---- case 2: missing row → createMachine returns starting → wait ----

{
  const store = makeStore();
  const machines = makeMachinesStub({
    onCreate: () => "starting",
  });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  await resolve("p2");
  const kinds = machines.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ["create", "get", "wait", "get"]);
  // The final state cached must be running.
  assert.equal(store.rows.get("p2").state, "running");
}

// ---- case 3: cached machine is stopped → start + wait ----

{
  const store = makeStore();
  await store.upsert({
    projectId: "p3",
    machineId: "m-existing",
    region: "fra",
    state: "stopped",
  });
  const machines = makeMachinesStub({
    initial: [{ id: "m-existing", state: "stopped", region: "fra" }],
    onStart: () => "starting",
  });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  const upstream = await resolve("p3");
  assert.equal(upstream.host, "m-existing.vm.test-app.internal");
  const kinds = machines.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ["get", "start", "wait", "get"]);
  assert.equal(store.rows.get("p3").state, "running");
}

// ---- case 4: cached machine already started → fast path ----

{
  const store = makeStore();
  await store.upsert({
    projectId: "p4",
    machineId: "m-warm",
    region: "fra",
    state: "running",
  });
  const machines = makeMachinesStub({
    initial: [{ id: "m-warm", state: "started", region: "fra" }],
  });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  await resolve("p4");
  const kinds = machines.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ["get"]);
  assert.equal(store.rows.get("p4").state, "running");
}

// ---- case 5: cached machine is destroyed → drop row, recreate ----

{
  const store = makeStore();
  await store.upsert({
    projectId: "p5",
    machineId: "m-dead",
    region: "fra",
    state: "running", // stale cache
  });
  const machines = makeMachinesStub({
    initial: [{ id: "m-dead", state: "destroyed", region: "fra" }],
    onCreate: () => "started",
  });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  const upstream = await resolve("p5");
  // New machine minted; host points at it, not m-dead.
  assert.notEqual(upstream.host, "m-dead.vm.test-app.internal");
  const row = store.rows.get("p5");
  assert.ok(row.machineId.startsWith("m-") && row.machineId !== "m-dead");
}

// ---- case 6: in-flight dedup — concurrent calls share one round-trip ----

{
  const store = makeStore();
  let createResolveFn = null;
  const machines = {
    appName: "test-app",
    calls: [],
    async createMachine(req) {
      this.calls.push("create");
      return new Promise((resolve) => {
        createResolveFn = () =>
          resolve({ id: "m-shared", state: "started", region: "fra" });
      });
    },
    async getMachine(id) {
      this.calls.push("get");
      return { id, state: "started", region: "fra" };
    },
    async startMachine() {
      throw new Error("unreachable");
    },
    async waitForState() {
      throw new Error("unreachable");
    },
    internalAddress(id) {
      return `${id}.vm.test-app.internal`;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  const p1 = resolve("p6");
  const p2 = resolve("p6");
  assert.strictEqual(p1, p2, "concurrent calls must share the promise");
  // Drain microtasks so the resolver's internal store.get() and
  // createMachine() calls have started.
  for (let i = 0; i < 5 && createResolveFn === null; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(createResolveFn, "createMachine should have been entered");
  createResolveFn();
  const [u1, u2] = await Promise.all([p1, p2]);
  assert.deepEqual(u1, u2);
  // createMachine was invoked exactly once.
  assert.equal(
    machines.calls.filter((c) => c === "create").length,
    1,
    `expected exactly one create, got ${machines.calls.join(",")}`,
  );
  // After settle, a fresh call starts a new round-trip.
  await resolve("p6");
  assert.equal(
    machines.calls.filter((c) => c === "create").length,
    1,
    "second call must hit the cached row, not recreate",
  );
}

// ---- case 7: createMachine throws → resolver rejects, no row written ----

{
  const store = makeStore();
  const machines = {
    appName: "test-app",
    async createMachine() {
      throw new Error("fly down");
    },
    async getMachine() {
      throw new Error("unreachable");
    },
    async startMachine() {},
    async waitForState() {},
    internalAddress(id) {
      return id;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
  });
  await assert.rejects(() => resolve("p7"), /fly down/);
  assert.equal(store.rows.get("p7"), undefined);
}

console.log("upstreamResolver ok");
