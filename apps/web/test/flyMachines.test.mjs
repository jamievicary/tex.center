// Unit tests for the Fly Machines API client (M7.1.0).
//
// Pure helpers (URL/header building, address derivation, state
// parsing) are exercised first. Then the `MachinesClient` methods
// are driven against a stub `fetch` that records each request,
// covering happy-path JSON parsing, non-ok status → `FlyApiError`,
// optional query-string + body shapes, and the wait endpoint URL.

import assert from "node:assert/strict";

import {
  FlyApiError,
  MachinesClient,
  buildAuthHeaders,
  buildMachinesUrl,
  internalAddress,
  parseMachineState,
} from "../src/lib/server/flyMachines.ts";

// ---- pure helpers ----

assert.equal(
  buildMachinesUrl("https://api.machines.dev/v1", "tex-center-sidecar", "machines"),
  "https://api.machines.dev/v1/apps/tex-center-sidecar/machines",
);

// Trailing slashes on baseUrl normalised away.
assert.equal(
  buildMachinesUrl("https://api.machines.dev/v1/", "app", "machines", "m1", "start"),
  "https://api.machines.dev/v1/apps/app/machines/m1/start",
);

// Path components are URL-encoded so unusual chars can't smuggle in.
assert.equal(
  buildMachinesUrl("https://x", "a/b", "machines", "m 1"),
  "https://x/apps/a%2Fb/machines/m%201",
);

assert.deepEqual(buildAuthHeaders("tok"), {
  Authorization: "Bearer tok",
  "Content-Type": "application/json",
});

assert.equal(
  internalAddress("tex-center-sidecar", "9080507f123456"),
  "9080507f123456.vm.tex-center-sidecar.internal",
);

assert.throws(
  () => internalAddress("tex-center-sidecar", "bad id"),
  /alphanumeric/,
);
assert.throws(
  () => internalAddress("bad app", "abc"),
  /alphanumeric/,
);

assert.equal(parseMachineState("started"), "started");
assert.equal(parseMachineState("stopped"), "stopped");
assert.throws(() => parseMachineState("running"), /Unrecognised/);
assert.throws(() => parseMachineState(42), /Unrecognised/);
assert.throws(() => parseMachineState(undefined), /Unrecognised/);

// ---- stub fetch infrastructure ----

function makeStubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const stub = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error(`stub fetch: no response queued for ${url}`);
    const status = next.status ?? 200;
    const bodyText =
      typeof next.body === "string"
        ? next.body
        : next.body === undefined
          ? ""
          : JSON.stringify(next.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return bodyText;
      },
    };
  };
  return { stub, calls };
}

// ---- createMachine ----

{
  const { stub, calls } = makeStubFetch([
    {
      status: 200,
      body: {
        id: "9080507f123456",
        name: "proj-abc",
        state: "starting",
        region: "fra",
        private_ip: "fdaa::1",
      },
    },
  ]);
  const client = new MachinesClient({
    token: "tok",
    appName: "tex-center-sidecar",
    fetch: stub,
  });
  const machine = await client.createMachine({
    name: "proj-abc",
    region: "fra",
    config: { image: "registry.fly.io/tex-center-sidecar:deployment-x" },
  });
  assert.equal(machine.id, "9080507f123456");
  assert.equal(machine.state, "starting");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.machines.dev/v1/apps/tex-center-sidecar/machines",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.name, "proj-abc");
  assert.equal(sent.region, "fra");
  assert.equal(
    sent.config.image,
    "registry.fly.io/tex-center-sidecar:deployment-x",
  );
}

// ---- createMachine: unknown state → throws ----

{
  const { stub } = makeStubFetch([
    { status: 200, body: { id: "m1", state: "spinning" } },
  ]);
  const client = new MachinesClient({
    token: "tok",
    appName: "app",
    fetch: stub,
  });
  await assert.rejects(
    () => client.createMachine({ config: { image: "img" } }),
    /Unrecognised Fly Machine state/,
  );
}

// ---- createMachine: missing id → throws ----

{
  const { stub } = makeStubFetch([
    { status: 200, body: { state: "started" } },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await assert.rejects(
    () => client.createMachine({ config: { image: "img" } }),
    /missing string `id`/,
  );
}

// ---- non-ok status → FlyApiError ----

{
  const { stub } = makeStubFetch([
    { status: 422, body: { error: "image required" } },
  ]);
  const client = new MachinesClient({
    token: "tok",
    appName: "app",
    fetch: stub,
  });
  try {
    await client.createMachine({ config: { image: "" } });
    assert.fail("expected FlyApiError");
  } catch (err) {
    assert.ok(err instanceof FlyApiError);
    assert.equal(err.status, 422);
    assert.deepEqual(err.body, { error: "image required" });
    assert.match(err.message, /422/);
  }
}

// ---- non-ok status with non-JSON body ----

{
  const { stub } = makeStubFetch([
    { status: 502, body: "<html>bad gateway</html>" },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  try {
    await client.getMachine("m1");
    assert.fail("expected FlyApiError");
  } catch (err) {
    assert.ok(err instanceof FlyApiError);
    assert.equal(err.status, 502);
    assert.equal(err.body, "<html>bad gateway</html>");
  }
}

// ---- getMachine ----

{
  const { stub, calls } = makeStubFetch([
    { status: 200, body: { id: "m1", state: "started" } },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  const m = await client.getMachine("m1");
  assert.equal(m.state, "started");
  assert.equal(calls[0].url, "https://api.machines.dev/v1/apps/app/machines/m1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
}

// ---- listMachines: GET /machines, parses array of Machine ----

{
  const { stub, calls } = makeStubFetch([
    {
      status: 200,
      body: [
        { id: "m1", state: "started" },
        { id: "m2", state: "stopped", image_ref: { digest: "sha256:abc" } },
      ],
    },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  const ms = await client.listMachines();
  assert.equal(calls[0].url, "https://api.machines.dev/v1/apps/app/machines");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(ms.length, 2);
  assert.equal(ms[0].id, "m1");
  assert.equal(ms[1].image_ref?.digest, "sha256:abc");
}

// listMachines: non-array body rejected.
{
  const { stub } = makeStubFetch([{ status: 200, body: { id: "m1", state: "started" } }]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await assert.rejects(() => client.listMachines(), /expected array response/);
}

// ---- startMachine ----

{
  const { stub, calls } = makeStubFetch([{ status: 200, body: { ok: true } }]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await client.startMachine("m1");
  assert.equal(
    calls[0].url,
    "https://api.machines.dev/v1/apps/app/machines/m1/start",
  );
  assert.equal(calls[0].init.method, "POST");
}

// ---- stopMachine: payload includes only provided fields ----

{
  const { stub, calls } = makeStubFetch([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await client.stopMachine("m1");
  assert.equal(calls[0].init.body, "{}");
  await client.stopMachine("m1", { signal: "SIGTERM", timeout: 30 });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    signal: "SIGTERM",
    timeout: 30,
  });
}

// ---- destroyMachine: force=true appended as query string ----

{
  const { stub, calls } = makeStubFetch([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await client.destroyMachine("m1");
  assert.equal(
    calls[0].url,
    "https://api.machines.dev/v1/apps/app/machines/m1",
  );
  await client.destroyMachine("m1", { force: true });
  assert.equal(
    calls[1].url,
    "https://api.machines.dev/v1/apps/app/machines/m1?force=true",
  );
  assert.equal(calls[1].init.method, "DELETE");
}

// ---- waitForState: query string carries state + timeout ----

{
  const { stub, calls } = makeStubFetch([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  await client.waitForState("m1", "started");
  assert.equal(
    calls[0].url,
    "https://api.machines.dev/v1/apps/app/machines/m1/wait?state=started&timeout=60",
  );
  await client.waitForState("m1", "stopped", { timeoutSec: 5 });
  assert.equal(
    calls[1].url,
    "https://api.machines.dev/v1/apps/app/machines/m1/wait?state=stopped&timeout=5",
  );
}

// ---- empty 200 response body is tolerated ----

{
  const { stub } = makeStubFetch([{ status: 200, body: undefined }]);
  const client = new MachinesClient({ token: "tok", appName: "app", fetch: stub });
  // start/stop/destroy/wait don't parse the body; no throw expected.
  await client.startMachine("m1");
}

// ---- constructor validation ----

assert.throws(
  () => new MachinesClient({ token: "", appName: "app" }),
  /token is required/,
);
assert.throws(
  () => new MachinesClient({ token: "t", appName: "" }),
  /appName is required/,
);

// ---- baseUrl override ----

{
  const { stub, calls } = makeStubFetch([
    { status: 200, body: { id: "m1", state: "started" } },
  ]);
  const client = new MachinesClient({
    token: "tok",
    appName: "app",
    baseUrl: "http://127.0.0.1:9999/v1",
    fetch: stub,
  });
  await client.getMachine("m1");
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:9999/v1/apps/app/machines/m1",
  );
}

// ---- internalAddress via client convenience ----

{
  const client = new MachinesClient({
    token: "t",
    appName: "tex-center-sidecar",
    fetch: async () => {
      throw new Error("not called");
    },
  });
  assert.equal(
    client.internalAddress("9080507f123456"),
    "9080507f123456.vm.tex-center-sidecar.internal",
  );
}

console.log("flyMachines.test.mjs ok");
