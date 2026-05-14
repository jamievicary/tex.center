// M13.2(b) iter 249: when the sidecar idle timer fires, it must
// (a) close the Fastify app, (b) try to suspend its own Fly Machine
// via the Machines API, and (c) fall back to a clean process.exit(0)
// if no suspend credentials are wired or the call errors. Production
// path freezes the VM mid-call (we never observe the resolved
// promise); unit tests cover the wiring without making real fetches.

import assert from "node:assert/strict";

import {
  buildSuspendSelfFromEnv,
  createIdleHandler,
} from "../src/index.ts";

// ---- buildSuspendSelfFromEnv: env gating ----

assert.equal(buildSuspendSelfFromEnv({}), null);
assert.equal(
  buildSuspendSelfFromEnv({ FLY_APP_NAME: "a", FLY_MACHINE_ID: "m" }),
  null,
);
assert.equal(
  buildSuspendSelfFromEnv({ FLY_APP_NAME: "a", FLY_API_TOKEN: "t" }),
  null,
);
assert.equal(
  buildSuspendSelfFromEnv({ FLY_MACHINE_ID: "m", FLY_API_TOKEN: "t" }),
  null,
);

// happy path: returns a function that fires the right POST.
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, async text() { return ""; } };
  };
  try {
    const fn = buildSuspendSelfFromEnv({
      FLY_APP_NAME: "tex-center-sidecar",
      FLY_MACHINE_ID: "abc123",
      FLY_API_TOKEN: "tok",
    });
    assert.equal(typeof fn, "function");
    await fn();
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.machines.dev/v1/apps/tex-center-sidecar/machines/abc123/suspend",
    );
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.authorization, "Bearer tok");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// non-2xx response: throws so the idle handler can log + fall back.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    async text() { return "suspend not supported"; },
  });
  try {
    const fn = buildSuspendSelfFromEnv({
      FLY_APP_NAME: "a",
      FLY_MACHINE_ID: "m",
      FLY_API_TOKEN: "t",
    });
    await assert.rejects(fn(), /fly suspend failed: 422/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- createIdleHandler: wiring ----

function fakeApp() {
  const closes = [];
  return {
    closes,
    close: async () => {
      closes.push(Date.now());
    },
  };
}

// no suspender wired (local dev): just close + exit(0).
{
  const app = fakeApp();
  const exits = [];
  const logs = [];
  const handler = createIdleHandler({
    getApp: () => app,
    suspendSelf: null,
    exit: (code) => {
      exits.push(code);
    },
    log: (msg, err) => logs.push([msg, err]),
  });
  handler();
  // Allow microtasks/awaits to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1);
  assert.deepEqual(exits, [0]);
  // No log lines on the happy local-dev path.
  assert.equal(logs.length, 0);
}

// suspender succeeds (in prod the VM would freeze; in tests it
// returns, and we exit(0) cleanly anyway).
{
  const app = fakeApp();
  const exits = [];
  const suspendCalls = [];
  const handler = createIdleHandler({
    getApp: () => app,
    suspendSelf: async () => {
      suspendCalls.push(1);
    },
    exit: (code) => {
      exits.push(code);
    },
    log: () => {},
  });
  handler();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1);
  assert.equal(suspendCalls.length, 1);
  assert.deepEqual(exits, [0]);
}

// suspender throws: handler still exits 0, error is logged.
{
  const app = fakeApp();
  const exits = [];
  const logs = [];
  const handler = createIdleHandler({
    getApp: () => app,
    suspendSelf: async () => {
      throw new Error("nope");
    },
    exit: (code) => {
      exits.push(code);
    },
    log: (msg, err) => logs.push([msg, err]),
  });
  handler();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(exits, [0]);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /suspend failed/);
}

// double-firing the handler must only close + exit once.
{
  const app = fakeApp();
  const exits = [];
  const handler = createIdleHandler({
    getApp: () => app,
    suspendSelf: null,
    exit: (code) => {
      exits.push(code);
    },
    log: () => {},
  });
  handler();
  handler();
  handler();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1);
  assert.deepEqual(exits, [0]);
}

console.log("idleSuspend ok");
