// M13.2(b) / M20.1 idle handlers — two-stage cascade.
//
// Production sequence on Fly:
//   1. Suspend timer fires (default 5 s) → handler awaits
//      POST /machines/{self}/suspend.
//   2. Fly responds, then freezes the VM. The fetch promise is
//      pending across the freeze.
//   3. Some time later a WS upgrade hits the Machine, the control
//      plane calls /start, the VM resumes. The pending fetch
//      resolves — we are now *post-resume*, with the same listener
//      still bound to the same port.
//   4. The suspend handler must NOT exit and must NOT close the
//      app; it must call ctx.rearm() so a future inactive window
//      can suspend us again. Iter 249 got step 3 wrong (it
//      `exit(0)`'d after the await, killing the resumed sidecar
//      ~1 s after every wake).
//
//   5. If no resume happens *and* the longer stop timer (default
//      300 s) elapses, the stop handler closes the app and exits 0.
//      That parks the Machine in `stopped` for the next cold-load
//      cycle. R2 (iter 267) removed eager exits from the suspend
//      handler; the stop handler is the only path to `stopped`.

import assert from "node:assert/strict";

import {
  buildSuspendSelfFromEnv,
  createSuspendHandler,
  createStopHandler,
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

// non-2xx response: throws so the suspend handler can log + fall back.
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

// ---- createSuspendHandler: wiring ----

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

// Suspender wired, succeeds (production post-resume path): handler
// must NOT close any app (the suspend handler can't see the app at
// all), must NOT exit, must call ctx.rearm().
{
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: async () => {
      suspendCalls.push(1);
    },
    log: () => {},
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(suspendCalls.length, 1);
  assert.equal(rearms.length, 1, "post-resume must re-arm idle gate");
}

// Suspender throws (Fly 5xx / bad token / network blip). M13.2(b).5
// R2: the suspend handler must NOT close any app and must NOT exit,
// because exit(0) would park the Machine in `stopped` (which is the
// stop handler's job, on the longer timer). Log the failure and
// re-arm so the next short window retries.
{
  const logs = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: async () => {
      throw new Error("nope");
    },
    log: (msg, err) => logs.push([msg, err]),
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    rearms.length,
    1,
    "suspend failure must re-arm the idle gate for retry",
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /suspend.*failed/);
}

// Suspender null (local dev, missing creds). M20.1: no exit from
// the suspend handler — the stop handler on the longer timer
// performs the eventual exit. Suspend just logs and re-arms.
{
  const logs = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: null,
    log: (msg, err) => logs.push([msg, err]),
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rearms.length, 1, "no-creds path still re-arms");
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /no suspendSelf/);
}

// After a suspend-failure path, the handler is no longer in-flight
// and the next idle window retries.
{
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: async () => {
      suspendCalls.push(1);
      throw new Error("flaky fly");
    },
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
}

// While a suspend is in flight, a second call is a no-op
// (re-entrancy guard).
{
  const suspendCalls = [];
  let releaseSuspend;
  const suspend = () =>
    new Promise((r) => {
      releaseSuspend = r;
    });
  const { ctx } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: async () => {
      suspendCalls.push(1);
      await suspend();
    },
    log: () => {},
  });
  handler(ctx);
  handler(ctx);
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(suspendCalls.length, 1, "in-flight guard");
  releaseSuspend();
  await new Promise((r) => setTimeout(r, 5));
}

// After a successful suspend/resume, the handler can fire again
// for a *second* idle window (`inFlight` must be cleared).
{
  const suspendCalls = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createSuspendHandler({
    suspendSelf: async () => {
      suspendCalls.push(1);
    },
    log: () => {},
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  handler(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(suspendCalls.length, 2, "second idle window must re-fire");
  assert.equal(rearms.length, 2);
}

// ---- createStopHandler: wiring ----

// Stop handler closes the app and exits 0 — the path to `stopped`.
{
  const app = fakeApp();
  const exits = [];
  const logs = [];
  const { ctx, rearms } = fakeCtx();
  const handler = createStopHandler({
    getApp: () => app,
    exit: (code) => {
      exits.push(code);
    },
    log: (msg, err) => logs.push([msg, err]),
  });
  handler(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1, "stop must close the app");
  assert.deepEqual(exits, [0], "stop must exit 0");
  // ctx.rearm is intentionally unused by stop (process is exiting).
  assert.equal(rearms.length, 0);
  assert.equal(logs.length, 0);
}

// Stop handler with app.close() failure still exits 0 — the Machine
// must reach `stopped` even if the listener teardown errored.
{
  const exits = [];
  const logs = [];
  const handler = createStopHandler({
    getApp: () => ({
      close: async () => {
        throw new Error("close failed");
      },
    }),
    exit: (code) => exits.push(code),
    log: (msg, err) => logs.push([msg, err]),
  });
  handler({ rearm: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(exits, [0]);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /close\(\) failed/);
}

// Stop handler is single-shot — second call is a no-op.
{
  const app = fakeApp();
  const exits = [];
  const handler = createStopHandler({
    getApp: () => app,
    exit: (code) => exits.push(code),
    log: () => {},
  });
  handler({ rearm: () => {} });
  handler({ rearm: () => {} });
  handler({ rearm: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.closes.length, 1, "stop must close exactly once");
  assert.deepEqual(exits, [0]);
}

console.log("idleSuspend ok");
