// M7.1.4 / M20.1 / M20.3 idle cascade. Iter 343 collapsed the
// two-stage cascade in production wiring: the sidecar now arms ONLY
// the stop stage on every idle entry (cold boot and viewer-disconnect
// 1→0). The suspend stage primitive is still available via
// `suspendTimeoutMs` / `onSuspend` (the `createIdleStage` plumbing
// is symmetric) but `buildServer` never auto-arms it. The disconnect
// arm of suspend was forbidden after iter 341/342 confirmed it raced
// transient cold-reopen WS open-then-close cycles to suspend a
// Machine mid-handshake (the 6PN dial after a suspend cannot
// auto-resume). See `src/server.ts` `noteViewerRemoved` comment and
// `.autodev/logs/343.md`.
//
// First viewer re-connection clears both stages. The stop handler
// closes the app and exits 0 — the path to `stopped`.

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

// Case 1 (iter 343): viewer disconnect 1→0 arms ONLY the stop stage.
// The suspend stage is wired with a much shorter timeout — even so,
// it must NOT fire, because `buildServer` no longer auto-arms it on
// any path.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-1-"));
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

  // Open the WS before the startup-armed stop timer can plausibly
  // fire. Once viewerCount becomes 1, the startup timer is cleared;
  // this case then measures the *disconnect-arm* path.
  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    suspendCalls,
    0,
    "iter-343 invariant: viewer disconnect must NOT arm suspend stage",
  );
  assert.equal(
    stopCalls,
    1,
    "viewer disconnect arms stop stage; onStop should fire once after timeout",
  );

  await app.close();
}

// Case 2: re-connection before stop-timeout cancels the timer.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-2-"));
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    stopTimeoutMs: 400,
    onStop: () => {
      stopCalls += 1;
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
  assert.equal(stopCalls, 0, "re-connection should cancel stop timer");

  await closeAndWait(ws2);
  // After this disconnect the timer arms again; verify it fires.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(stopCalls, 1, "onStop should fire after final disconnect");

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

// Case 4: multi-viewer — stop arms only when the *last* viewer leaves.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-4-"));
  let stopCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    stopTimeoutMs: 300,
    onStop: () => {
      stopCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const a = await open(`ws://127.0.0.1:${port}/ws/project/pA`);
  const b = await open(`ws://127.0.0.1:${port}/ws/project/pB`);
  await closeAndWait(a);
  // One viewer remains → timer must not fire.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(stopCalls, 0, "timer should not fire while viewers remain");
  await closeAndWait(b);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(stopCalls, 1, "timer should fire after the last viewer leaves");

  await app.close();
}

// Case 5 (regression for live-prod bug seen iter 176, refined
// iter 340, generalised iter 343): if the server boots but no viewer
// ever connects, the orphan must still be cleaned up via the STOP
// stage. The suspend stage must NOT fire on cold boot (iter 340) and
// must NOT fire on any code path from `buildServer` (iter 343). The
// orphan rationale (no indefinite billing) still holds — the stop
// stage's longer timer is the failsafe — but suspend is forbidden
// because the 6PN dial that follows a Fly-suspended Machine can't
// auto-resume it.
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

// Case 6 (M20.1): the stop timer fires independently when only it
// is wired.
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

// Case 7 (iter 343): viewer re-connection during the cold-boot stop
// window clears the timer, so it does not fire until the next
// disconnect. With the iter-343 contract, `noteViewerAdded` calls
// `clearIdleTimers()` for both stages (suspend stays cleared because
// it was never armed; stop is cleared because it was startup-armed).
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

  // Connect inside the startup-armed stop window so the timer is
  // cleared before it can fire.
  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p8`);
  // Hold open well past both timeouts.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(suspendCalls, 0, "suspend must NEVER fire from buildServer");
  assert.equal(stopCalls, 0, "active viewer cancels stop timer");

  await closeAndWait(ws);
  await app.close();
}

console.log("sidecar idle-stop test: OK");
