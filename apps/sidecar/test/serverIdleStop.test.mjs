// Idle-stop wiring (M7.1.4): sidecar invokes onIdle after the
// last viewer disconnects and the configured timeout elapses;
// re-connection cancels the pending timer.

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

// Case 1: timer fires after last viewer disconnects.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-1-"));
  let idleCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    idleTimeoutMs: 50,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(idleCalls, 1, "onIdle should fire once after timeout");

  await app.close();
}

// Case 2: re-connection before timeout cancels the timer.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-2-"));
  let idleCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    idleTimeoutMs: 200,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws1 = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws1);
  // Re-connect well before the 200ms timeout.
  await new Promise((r) => setTimeout(r, 30));
  const ws2 = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  // Wait past the original timeout — timer should have been cleared.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(idleCalls, 0, "re-connection should cancel idle timer");

  await closeAndWait(ws2);
  // After this disconnect the timer arms again; verify it fires.
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(idleCalls, 1, "onIdle should fire after final disconnect");

  await app.close();
}

// Case 3: feature off when idleTimeoutMs unset — no firing even
// after viewers come and go.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-3-"));
  let idleCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);
  await closeAndWait(ws);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(idleCalls, 0, "no idle when idleTimeoutMs unset");

  await app.close();
}

// Case 4: multi-viewer — timer arms only when the *last* viewer leaves.
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-idle-4-"));
  let idleCalls = 0;
  const app = await buildServer({
    logger: false,
    scratchRoot,
    idleTimeoutMs: 80,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const a = await open(`ws://127.0.0.1:${port}/ws/project/pA`);
  const b = await open(`ws://127.0.0.1:${port}/ws/project/pB`);
  await closeAndWait(a);
  // One viewer remains → timer must not fire.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(idleCalls, 0, "timer should not fire while viewers remain");
  await closeAndWait(b);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(idleCalls, 1, "timer should fire after the last viewer leaves");

  await app.close();
}

console.log("sidecar idle-stop test: OK");
