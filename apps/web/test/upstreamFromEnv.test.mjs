// Unit tests for the env-gated resolver factory used by the
// production entry. Verifies that the resolver is constructed only
// when all required env vars are present, and that it propagates
// `SIDECAR_IMAGE` into the machine config and dials the address
// computed from `SIDECAR_APP_NAME`.

import assert from "node:assert/strict";

import { buildUpstreamFromEnv } from "../src/lib/server/upstreamFromEnv.ts";

function makeStore() {
  const rows = new Map();
  return {
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

function makeMachinesStub(appName) {
  const calls = [];
  return {
    appName,
    calls,
    async createMachine(req) {
      calls.push({ kind: "create", req });
      return { id: "m-123", state: "started", region: req.region ?? "fra" };
    },
    async getMachine(id) {
      calls.push({ kind: "get", id });
      return { id, state: "started" };
    },
    async startMachine(id) {
      calls.push({ kind: "start", id });
    },
    async stopMachine() {},
    async destroyMachine() {},
    async waitForState(id, state) {
      calls.push({ kind: "wait", id, state });
    },
    internalAddress(id) {
      return `${id}.vm.${appName}.internal`;
    },
  };
}

// ---- null on missing env ----

const baseDeps = {
  makeMachinesClient: () => makeMachinesStub("noop"),
  makeStore: () => makeStore(),
  tcpProbe: async () => {},
};

assert.equal(buildUpstreamFromEnv({}, baseDeps), null);
assert.equal(
  buildUpstreamFromEnv(
    { FLY_API_TOKEN: "t", SIDECAR_APP_NAME: "a" },
    baseDeps,
  ),
  null,
);
assert.equal(
  buildUpstreamFromEnv(
    { FLY_API_TOKEN: "t", SIDECAR_IMAGE: "i" },
    baseDeps,
  ),
  null,
);
assert.equal(
  buildUpstreamFromEnv(
    { SIDECAR_APP_NAME: "a", SIDECAR_IMAGE: "i" },
    baseDeps,
  ),
  null,
);

// makeMachinesClient / makeStore must NOT be called when env is
// incomplete — otherwise a missing DATABASE_URL would crash the
// fallback path at boot.
{
  let madeClient = false;
  let madeStore = false;
  const r = buildUpstreamFromEnv(
    { FLY_API_TOKEN: "t", SIDECAR_APP_NAME: "a" },
    {
      makeMachinesClient: () => {
        madeClient = true;
        return makeMachinesStub("a");
      },
      makeStore: () => {
        madeStore = true;
        return makeStore();
      },
    },
  );
  assert.equal(r, null);
  assert.equal(madeClient, false);
  assert.equal(madeStore, false);
}

// ---- happy path ----

{
  let observedToken = null;
  let observedAppName = null;
  const stub = makeMachinesStub("sidecar-app");
  const resolver = buildUpstreamFromEnv(
    {
      FLY_API_TOKEN: "fly-token",
      SIDECAR_APP_NAME: "sidecar-app",
      SIDECAR_IMAGE: "registry/sidecar:abc",
    },
    {
      makeMachinesClient: ({ token, appName }) => {
        observedToken = token;
        observedAppName = appName;
        return stub;
      },
      makeStore: () => makeStore(),
      tcpProbe: async () => {},
    },
  );
  assert.notEqual(resolver, null);
  assert.equal(observedToken, "fly-token");
  assert.equal(observedAppName, "sidecar-app");

  const upstream = await resolver("proj-1");
  assert.equal(upstream.host, "m-123.vm.sidecar-app.internal");
  assert.equal(upstream.port, 3001); // DEFAULT_SIDECAR_PORT

  // createMachine got the image from SIDECAR_IMAGE plus the safety
  // defaults.
  const createCall = stub.calls.find((c) => c.kind === "create");
  assert.ok(createCall);
  assert.equal(createCall.req.region, "fra");
  assert.equal(createCall.req.config.image, "registry/sidecar:abc");
  // M13.2(b) iter 249: auto_destroy=false. Per-project Machines
  // suspend (kernel snapshot) on idle and resume on next connect,
  // avoiding the ~5 GB image-pull cost of cold-creation. The
  // orphan sweep (filters by known project IDs) bounds leaks.
  assert.equal(createCall.req.config.auto_destroy, false);
  assert.deepEqual(createCall.req.config.restart, { policy: "on-failure" });
  // Iter 154: per-project Machines must be sized large enough to
  // survive the sidecar's runtime total-vm footprint. 1GB is the
  // floor; anything smaller OOM-killed under real WS traffic on the
  // Fly Machines API default. Lock in a >= 1024 invariant so a
  // future refactor can't silently regress to the default.
  assert.ok(
    createCall.req.config.guest,
    "machineConfig.guest must be set so Fly doesn't fall back to the ~256MB default",
  );
  assert.ok(
    typeof createCall.req.config.guest.memory_mb === "number" &&
      createCall.req.config.guest.memory_mb >= 1024,
    `machineConfig.guest.memory_mb must be >= 1024 (got ${createCall.req.config.guest.memory_mb})`,
  );
}

// ---- SIDECAR_PORT / SIDECAR_REGION override ----

{
  const stub = makeMachinesStub("app2");
  const resolver = buildUpstreamFromEnv(
    {
      FLY_API_TOKEN: "t",
      SIDECAR_APP_NAME: "app2",
      SIDECAR_IMAGE: "img",
      SIDECAR_PORT: "4242",
      SIDECAR_REGION: "iad",
    },
    {
      makeMachinesClient: () => stub,
      makeStore: () => makeStore(),
      tcpProbe: async () => {},
    },
  );
  const upstream = await resolver("p");
  assert.equal(upstream.port, 4242);
  const createCall = stub.calls.find((c) => c.kind === "create");
  assert.equal(createCall.req.region, "iad");
}

// ---- SIDECAR_PORT validation ----

assert.throws(
  () =>
    buildUpstreamFromEnv(
      {
        FLY_API_TOKEN: "t",
        SIDECAR_APP_NAME: "a",
        SIDECAR_IMAGE: "i",
        SIDECAR_PORT: "0",
      },
      baseDeps,
    ),
  /SIDECAR_PORT/,
);
assert.throws(
  () =>
    buildUpstreamFromEnv(
      {
        FLY_API_TOKEN: "t",
        SIDECAR_APP_NAME: "a",
        SIDECAR_IMAGE: "i",
        SIDECAR_PORT: "nope",
      },
      baseDeps,
    ),
  /SIDECAR_PORT/,
);

console.log("upstreamFromEnv ok");
