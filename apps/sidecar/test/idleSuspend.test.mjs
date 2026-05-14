// M13.2(b) idle handler — iter 255 rewrite.
//
// Production sequence on Fly:
//   1. Idle timer fires → handler awaits POST /machines/{self}/suspend.
//   2. Fly responds, then freezes the VM. The fetch promise is
//      pending across the freeze.
//   3. Some time later a WS upgrade hits the Machine, the control
//      plane calls /start, the VM resumes. The pending fetch
//      resolves — we are now *post-resume*, with the same listener
//      still bound to the same port.
//   4. The handler must NOT exit and must NOT close the app; it
//      must re-arm the idle gate so a future inactive window can
//      suspend us again.
//
// Iter 249 got step 3 wrong (it `exit(0)`'d after the await, killing
// the resumed sidecar ~1 s after every wake). This test pins the
// correct post-resume contract.

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

function fakeCtx() {
  const rearms = [];
  return {
    rearms,
    ctx: { rearm: () => rearms.push(Date.now()) },
  };
}

// No suspender wired (local dev): close + exit(0). Rearm is NOT
// called because the process is going away.
{
  const app = fakeApp();
  const exits = [];
  const logs = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createIdleHandler({
    getApp: () => app,
    suspendSelf: null,
    exit: (code) => {
      exits.push(code);
    },
    log: (msg, err) => logs.push([msg, err]),
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1);
  assert.deepEqual(exits, [0]);
  assert.equal(rearms.length, 0);
  assert.equal(logs.length, 0);
}

// Suspender succeeds (production post-resume path): handler must
// NOT close the app, must NOT exit, must call ctx.rearm().
{
  const app = fakeApp();
  const exits = [];
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
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
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    app.closes.length,
    0,
    "post-resume must not close the listener",
  );
  assert.equal(suspendCalls.length, 1);
  assert.deepEqual(exits, [], "post-resume must not exit");
  assert.equal(rearms.length, 1, "post-resume must re-arm idle gate");
}

// Suspender throws (Fly 5xx / bad token / network blip). M13.2(b).5
// R2: the handler must NOT close the app and must NOT exit, because
// exit(0) would park the Machine in `stopped` (the 20 s+ cold-load
// path). Log the failure and re-arm so the next idle window
// retries.
{
  const app = fakeApp();
  const exits = [];
  const logs = [];
  const { ctx, rearms } = fakeCtx();
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
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    app.closes.length,
    0,
    "suspend failure must not close the listener (R2: never reach `stopped`)",
  );
  assert.deepEqual(
    exits,
    [],
    "suspend failure must not exit (R2: never reach `stopped`)",
  );
  assert.equal(
    rearms.length,
    1,
    "suspend failure must re-arm the idle gate for retry",
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /suspend failed/);
}

// After a suspend-failure path, the handler is no longer in-flight
// and the next idle window retries — exercising the
// stay-alive-and-retry contract.
{
  const exits = [];
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createIdleHandler({
    getApp: () => fakeApp(),
    suspendSelf: async () => {
      suspendCalls.push(1);
      throw new Error("flaky fly");
    },
    exit: (code) => exits.push(code),
    log: () => {},
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    suspendCalls.length,
    2,
    "suspend failure must clear inFlight so the next idle window retries",
  );
  assert.equal(rearms.length, 2);
  assert.deepEqual(exits, []);
}

// While a suspend is in flight, a second call is a no-op
// (re-entrancy guard).
{
  const exits = [];
  const suspendCalls = [];
  let releaseSuspend;
  const suspend = () =>
    new Promise((r) => {
      releaseSuspend = r;
    });
  const { ctx } = fakeCtx();
  const handler = createIdleHandler({
    getApp: () => fakeApp(),
    suspendSelf: async () => {
      suspendCalls.push(1);
      await suspend();
    },
    exit: (code) => exits.push(code),
    log: () => {},
  });
  handler(ctx);
  handler(ctx);
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(suspendCalls.length, 1, "in-flight guard");
  releaseSuspend();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(exits, []);
}

// After a successful suspend/resume, the handler can fire again
// for a *second* idle window (`inFlight` must be cleared).
{
  const exits = [];
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createIdleHandler({
    getApp: () => fakeApp(),
    suspendSelf: async () => {
      suspendCalls.push(1);
    },
    exit: (code) => exits.push(code),
    log: () => {},
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(suspendCalls.length, 2, "second idle window must re-fire");
  assert.equal(rearms.length, 2);
  assert.deepEqual(exits, []);
}

console.log("idleSuspend ok");
