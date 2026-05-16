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
      calls.push({ kind: "create", id, state, req });
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
  // Skip the real net.connect probe in unit tests by default. Cases
  // that exercise the probe path supply their own stub.
  tcpProbe: async () => {},
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

  // M9.live-hygiene.leaked-machines (iter 243): every per-project
  // Machine the control plane creates must carry the
  // `texcenter_project=<projectId>` metadata tag so the leak
  // guardrail can distinguish it from the `app`-tagged shared pool.
  const createCall = machines.calls.find((c) => c.kind === "create");
  assert.equal(
    createCall.req.config.metadata.texcenter_project,
    "p1",
    "createMachine must tag with texcenter_project=<projectId>",
  );
}

// ---- case 1b: createMachine merges texcenter_project tag without
// clobbering caller-supplied metadata ----
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    machineConfig: {
      image: "registry.example/sidecar:latest",
      metadata: { app: "shared", foo: "bar" },
    },
  });
  await resolve("p1b");
  const createCall = machines.calls.find((c) => c.kind === "create");
  assert.deepEqual(createCall.req.config.metadata, {
    app: "shared",
    foo: "bar",
    texcenter_project: "p1b",
  });
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

// ---- case 8: 408 on waitForState("started") is retried under cold-start budget ----
//
// Iter 164 diagnosis: a fresh per-project Fly Machine can take >60s
// to reach `started` because of image pull; the Fly API's `/wait`
// endpoint caps `timeoutSec` at 60 and returns 408 on timeout. The
// resolver must retry until the overall cold-start budget elapses.
{
  const store = makeStore();
  let waitCalls = 0;
  const machines = {
    appName: "test-app",
    async createMachine(req) {
      return { id: "m-cold", state: "created", region: req.region };
    },
    async getMachine(id) {
      // After the retry succeeds we report "started".
      return { id, state: waitCalls >= 2 ? "started" : "created" };
    },
    async startMachine() {},
    async waitForState(_id, state, _opts) {
      waitCalls += 1;
      if (state === "started" && waitCalls < 2) {
        const err = new Error("Fly Machines API 408 deadline_exceeded");
        err.status = 408;
        throw err;
      }
    },
    internalAddress(id) {
      return `${id}.vm.test-app.internal`;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    coldStartTimeoutSec: 300,
  });
  const upstream = await resolve("p8");
  assert.equal(upstream.host, "m-cold.vm.test-app.internal");
  assert.equal(waitCalls, 2, "must retry once after 408");
}

// ---- case 9: 408 past cold-start deadline propagates ----
{
  const store = makeStore();
  const machines = {
    appName: "test-app",
    async createMachine(req) {
      return { id: "m-toolate", state: "created", region: req.region };
    },
    async getMachine(id) {
      return { id, state: "created" };
    },
    async startMachine() {},
    async waitForState() {
      const err = new Error("Fly Machines API 408 deadline_exceeded");
      err.status = 408;
      throw err;
    },
    internalAddress(id) {
      return id;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    coldStartTimeoutSec: 0,
  });
  await assert.rejects(() => resolve("p9"), /408/);
}

// ---- case 10: TCP probe retries past initial ECONNREFUSED ----
//
// Iter 168 diagnosis: after Fly reports the Machine `started`, the
// sidecar's user process still needs a moment to bind to port 3001.
// A dial that races the bind gets ECONNREFUSED. The resolver must
// retry the TCP probe under a bounded budget rather than returning
// an upstream that immediately fails on dial.
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  let probeCalls = 0;
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    tcpProbe: async () => {
      probeCalls += 1;
      if (probeCalls < 3) {
        const err = new Error("connect ECONNREFUSED");
        err.code = "ECONNREFUSED";
        throw err;
      }
    },
    tcpProbeTimeoutSec: 30,
  });
  const upstream = await resolve("p10");
  assert.equal(upstream.host, "m-1.vm.test-app.internal");
  assert.equal(probeCalls, 3, "probe must retry on ECONNREFUSED");
}

// ---- case 11: TCP probe deadline propagates as a resolver error ----
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    tcpProbe: async () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    },
    tcpProbeTimeoutSec: 0,
  });
  await assert.rejects(
    () => resolve("p11"),
    /did not accept TCP within probe budget/,
  );
}

// ---- case 12: seedDocFor → SEED_MAIN_DOC_B64 env on first create ----
//
// M15 Step D: when `projects.seed_doc` is non-null, the resolver
// bakes its bytes (base64-encoded) into the new Machine's env so
// the sidecar uses them for `main.tex` on first hydration.
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  const TWO_PAGE =
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    "Page one.\n" +
    "\\newpage\n" +
    "Page two.\n" +
    "\\end{document}\n";
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    seedDocFor: async (id) => (id === "p-seed" ? TWO_PAGE : null),
  });
  await resolve("p-seed");
  const createCall = machines.calls.find((c) => c.kind === "create");
  assert.ok(
    createCall.req.config.env,
    "createMachine must receive an env block when seed is non-null",
  );
  assert.equal(
    createCall.req.config.env.SEED_MAIN_DOC_B64,
    Buffer.from(TWO_PAGE, "utf8").toString("base64"),
  );
}

// ---- case 13: seedDocFor returning null → no SEED_MAIN_DOC_B64 env ----
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    seedDocFor: async () => null,
  });
  await resolve("p-unseeded");
  const createCall = machines.calls.find((c) => c.kind === "create");
  assert.equal(
    createCall.req.config.env?.SEED_MAIN_DOC_B64 ?? null,
    null,
    "no env entry when seed is null",
  );
}

// ---- case 14: seedDocFor throw is reported but does not block ----
{
  const store = makeStore();
  const machines = makeMachinesStub({ onCreate: () => "started" });
  const errs = [];
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    seedDocFor: async () => {
      throw new Error("db transient");
    },
    onSeedDocError: (detail) => errs.push(detail),
  });
  const upstream = await resolve("p-seed-err");
  assert.ok(upstream.host, "resolve must succeed even when seed lookup throws");
  assert.equal(errs.length, 1, "onSeedDocError fires once");
  assert.equal(errs[0].projectId, "p-seed-err");
  assert.match(errs[0].message, /db transient/);
  const createCall = machines.calls.find((c) => c.kind === "create");
  assert.equal(
    createCall.req.config.env?.SEED_MAIN_DOC_B64 ?? null,
    null,
    "no env entry when seed lookup throws",
  );
}

// ---- case 15: seedDocFor only consulted on first create (cached path skips) ----
{
  const store = makeStore();
  await store.upsert({
    projectId: "p-cached",
    machineId: "m-existing",
    region: "fra",
    state: "running",
  });
  const machines = makeMachinesStub({
    initial: [{ id: "m-existing", state: "started", region: "fra" }],
  });
  let seedCalls = 0;
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    seedDocFor: async () => {
      seedCalls += 1;
      return "irrelevant";
    },
  });
  await resolve("p-cached");
  assert.equal(seedCalls, 0, "seedDocFor not called when machine already exists");
}

// ---- case 11: 412 on startMachine for a stopped machine is retried ----
//
// Iter 376 diagnosis (GT-6 stopped gold failure): Fly's
// `POST /machines/{id}/stop` is asynchronous — the API can report
// `state=stopped` before the runtime has finished tearing down, and
// a subsequent `startMachine` within the gap returns
// `412 failed_precondition: machine still active`. Resolver must
// retry 412 until a bounded budget elapses.
{
  const store = makeStore();
  await store.upsert({
    projectId: "p11",
    machineId: "m-still-active",
    region: "fra",
    state: "stopped",
  });
  const machines = {
    appName: "test-app",
    async createMachine() {
      throw new Error("createMachine should not be called when row is cached");
    },
    async getMachine(id) {
      return { id, state: "stopped", region: "fra" };
    },
    startCalls: 0,
    async startMachine(_id) {
      this.startCalls += 1;
      if (this.startCalls === 1) {
        const err = new Error(
          "Fly Machines API 412 failed_precondition: machine still active",
        );
        err.status = 412;
        throw err;
      }
      // Second attempt succeeds.
    },
    async waitForState() {},
    internalAddress(id) {
      return `${id}.vm.test-app.internal`;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    // Sub-second budget keeps the test fast; the 250 ms backoff in
    // the resolver fits comfortably under 2 s.
    startMachineRetryTimeoutSec: 2,
  });
  const upstream = await resolve("p11");
  assert.equal(upstream.host, "m-still-active.vm.test-app.internal");
  assert.equal(
    machines.startCalls,
    2,
    "startMachine must retry exactly once after 412",
  );
}

// ---- case 12: persistent 412 past the retry budget propagates ----
{
  const store = makeStore();
  await store.upsert({
    projectId: "p12",
    machineId: "m-stuck-active",
    region: "fra",
    state: "stopped",
  });
  const machines = {
    appName: "test-app",
    async createMachine() {
      throw new Error("createMachine should not be called when row is cached");
    },
    async getMachine(id) {
      return { id, state: "stopped", region: "fra" };
    },
    startCalls: 0,
    async startMachine(_id) {
      this.startCalls += 1;
      const err = new Error(
        "Fly Machines API 412 failed_precondition: machine still active",
      );
      err.status = 412;
      throw err;
    },
    async waitForState() {},
    internalAddress(id) {
      return id;
    },
  };
  const resolve = createUpstreamResolver({
    ...baseOpts,
    machines,
    store,
    // Zero budget: the loop attempts once, sees the deadline already
    // past, rethrows. Keeps the test deterministic and instant.
    startMachineRetryTimeoutSec: 0,
  });
  await assert.rejects(() => resolve("p12"), /412/);
  assert.ok(
    machines.startCalls >= 1,
    "startMachine must have been attempted at least once",
  );
}

console.log("upstreamResolver ok");
