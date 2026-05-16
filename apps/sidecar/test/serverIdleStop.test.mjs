// M7.1.4 / M20.1 two-stage idle cascade. The sidecar arms two
// independent timers when `viewerCount` is zero:
//   - `suspendTimeoutMs` (short) invokes `onSuspend` then re-arms.
//   - `stopTimeoutMs`    (long)  invokes `onStop` (cold-storage).
// First viewer re-connection clears both. Either timer is
// independently disabled by setting its `*-TimeoutMs` unset or 0,
// or its `on*` handler missing.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { buildServer } from "../src/server.ts";

async function open(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function closeAndWait(ws) {
  ws.close();
  await new Promise((r) => ws.once("close", r));
}

// Case 1: suspend timer fires after last viewer disconnects.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-1-"));
  let suspendCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 300,
    onSuspend: () => {
      suspendCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  // Open the WS before the startup-armed timer can plausibly
  // fire. Once viewerCount becomes 1, the startup timer is
  // cleared; this case then measures the *disconnect-arm* path.
  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(suspendCalls, 1, "onSuspend should fire once after timeout");

  await app.close();
}

// Case 2: re-connection before suspend-timeout cancels the timer.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-2-"));
  let suspendCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 400,
    onSuspend: () => {
      suspendCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws1 = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws1);
  // Re-connect well before the 400ms disconnect-armed timeout.
  await new Promise((r) => setTimeout(r, 50));
  const ws2 = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  // Wait past the original timeout — timer should have been cleared.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(suspendCalls, 0, "re-connection should cancel suspend timer");

  await closeAndWait(ws2);
  // After this disconnect the timer arms again; verify it fires.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(suspendCalls, 1, "onSuspend should fire after final disconnect");

  await app.close();
}

// Case 3: feature off when neither timeout is set — no firing even
// after viewers come and go.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-3-"));
  let suspendCalls = 0;
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    onSuspend: () => {
      suspendCalls += 1;
    },
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(suspendCalls, 0, "no suspend when timeout unset");
  assert.equal(stopCalls, 0, "no stop when timeout unset");

  await app.close();
}

// Case 4: multi-viewer — suspend arms only when the *last* viewer leaves.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-4-"));
  let suspendCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 300,
    onSuspend: () => {
      suspendCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const a = await open(`ws://127.0.0.1:${port}/ws/project/pA`);
  const b = await open(`ws://127.0.0.1:${port}/ws/project/pB`);
  await closeAndWait(a);
  // One viewer remains → timer must not fire.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(suspendCalls, 0, "timer should not fire while viewers remain");
  await closeAndWait(b);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(suspendCalls, 1, "timer should fire after the last viewer leaves");

  await app.close();
}

// Case 5 (regression for live-prod bug seen iter 176, refined
// iter 340): if the server boots but no viewer ever connects, the
// orphan must still be cleaned up — but via the STOP stage only,
// not the suspend stage. iter 340 traced GT-9 + GT-6-stopped gold
// failures to the cold-boot suspend timer firing mid-handshake
// (5 s default suspend timeout < the web proxy's worst-case
// cold-start drive-to-started + tcpProbe + WS upgrade chain). The
// orphan rationale (no indefinite billing) still holds — the stop
// stage's longer timer is the failsafe — but suspend on cold boot
// is now forbidden because the 6PN dial that follows can't
// auto-resume a Fly-suspended Machine.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-5-"));
  let suspendCalls = 0;
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 50,
    onSuspend: () => {
      suspendCalls += 1;
    },
    stopTimeoutMs: 150,
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });

  // Never open a WebSocket. Wait past BOTH timeouts.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(
    suspendCalls,
    0,
    "cold-boot suspend timer must NOT fire — racing against resolver+WS-handshake",
  );
  assert.equal(
    stopCalls,
    1,
    "cold-boot stop timer (orphan cleanup) must still fire when no viewer connects",
  );

  await app.close();
}

// Case 6 (M20.1): the stop timer fires independently of the suspend
// timer. With a short stop timer and no suspend timer wired, the
// stop handler fires after viewers leave.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-6-"));
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    stopTimeoutMs: 200,
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p6`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(stopCalls, 1, "onStop should fire at its own boundary");

  await app.close();
}

// Case 7 (M20.1): with BOTH timers wired and the suspend handler
// re-arming itself but never closing the listener, the stop timer
// still fires at its (longer) boundary while the suspend timer can
// fire repeatedly in the same idle window via rearm.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-7-"));
  let suspendCalls = 0;
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 100,
    onSuspend: (ctx) => {
      suspendCalls += 1;
      // Production semantics: suspend handler re-arms itself
      // (post-resume or post-failure) but never closes the app.
      ctx.rearm();
    },
    stopTimeoutMs: 500,
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p7`);
  await closeAndWait(ws);
  // Wait long enough that the suspend timer can fire ~3 times and
  // the single stop timer fires exactly once.
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(
    suspendCalls >= 2,
    `suspend should re-fire multiple times via rearm (got ${suspendCalls})`,
  );
  assert.equal(stopCalls, 1, "stop fires exactly once at its boundary");

  await app.close();
}

// Case 8 (M20.1, refined iter 340): viewer re-connection during
// the cold-boot stop window clears BOTH timers, so neither
// suspend nor stop fires until the next disconnect. (After
// iter 340 only stop is armed on cold boot, but a viewer connect
// is still a `noteViewerAdded` that calls `clearIdleTimers()` for
// both stages, so this invariant — "active viewer ⇒ neither
// fires" — is unchanged.)
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-8-"));
  let suspendCalls = 0;
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    suspendTimeoutMs: 100,
    onSuspend: () => {
      suspendCalls += 1;
    },
    stopTimeoutMs: 300,
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  // Connect inside the startup-armed suspend window so both timers
  // are cleared before either fires.
  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p8`);
  // Hold open well past both timeouts.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(suspendCalls, 0, "active viewer cancels suspend timer");
  assert.equal(stopCalls, 0, "active viewer cancels stop timer");

  await closeAndWait(ws);
  await app.close();
}

console.log("sidecar idle-stop test: OK");
