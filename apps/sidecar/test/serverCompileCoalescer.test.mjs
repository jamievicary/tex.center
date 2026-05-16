// Compile-coalescer behaviour (per `172_answer.md` items 2/3/5).
//
// The pre-coalescer server gated only on a pending debounce
// timer, so a doc-update arriving during an in-flight compile
// reached the underlying compiler and tripped its
// "another compile already in flight" guard. After iter 178 the
// sidecar's `ProjectState` carries a `compileInFlight` /
// `pendingCompile` pair; bursts of updates collapse into "the
// running compile + at most one queued follow-up with the latest
// source", and the underlying `Compiler.compile()` is never
// called overlappingly.
//
// We exercise the coalescer with a `ManualCompiler` whose
// `compile()` returns a promise the test resolves explicitly.

import assert from "node:assert/strict";

import * as Y from "yjs";

import { encodeControl, encodeDocUpdate, MAIN_DOC_NAME } from "../../../packages/protocol/src/index.ts";

import { bootClient, closeClient, startServer, waitFor } from "./lib.mjs";

const TINY_PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, // "%PDF-1.4\n"
]);

function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

class ManualCompiler {
  constructor() {
    this.calls = [];
    this.closed = false;
  }
  compile(req) {
    const d = makeDeferred();
    const entry = {
      req,
      promise: d.promise,
      resolveSuccess: (shipoutPage) => {
        d.resolve({
          ok: true,
          segments: [
            { totalLength: TINY_PDF.length, offset: 0, bytes: TINY_PDF },
          ],
          shipoutPage,
        });
      },
      resolveError: (msg) => {
        d.resolve({ ok: false, error: msg });
      },
    };
    this.calls.push(entry);
    return d.promise;
  }
  async close() { this.closed = true; }
  async warmup() {}
  async snapshot() { return null; }
  async restore() {}
}

async function bootCoalescerServer() {
  const manual = new ManualCompiler();
  const app = await startServer({
    compilerFactory: () => manual,
  });
  return { app, manual };
}

// ---------- Case 1: in-flight gate collapses a burst into one
// follow-up compile. ----------
{
  const { app, manual } = await bootCoalescerServer();
  const { ws, frames, clientDoc, text } = await bootClient(app, "burst");

  await waitFor(
    () => manual.calls.length === 1,
    "initial compile call landed on ManualCompiler",
    frames,
  );

  // While the initial compile is still in flight, fire 50 rapid
  // doc-updates. None of these may reach the compiler — they must
  // all collapse into a single queued follow-up.
  for (let i = 0; i < 50; i++) {
    const before = Y.encodeStateVector(clientDoc);
    text.insert(text.length, `x${i}`);
    ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc, before)));
  }

  // Resolve the initial compile.
  manual.calls[0].resolveSuccess(1);

  // Allow the coalescer to drain: debounce window + slack.
  await waitFor(
    () => manual.calls.length === 2,
    "exactly one follow-up compile after the burst",
    frames,
  );

  // Settle and confirm we never went past two: the second compile
  // is still in flight; resolve it and verify no third call.
  manual.calls[1].resolveSuccess(1);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    manual.calls.length,
    2,
    `expected exactly 2 compile calls (initial + one follow-up), saw ${manual.calls.length}`,
  );

  // No `another compile already in flight` error must have leaked
  // out — the coalescer's whole purpose.
  const overlapErrors = frames.filter(
    (f) =>
      f.kind === "control" &&
      f.message.type === "compile-status" &&
      f.message.state === "error" &&
      /already in flight/i.test(f.message.detail ?? ""),
  );
  assert.equal(overlapErrors.length, 0, "no overlap error frames");

  await closeClient(ws, app);
}

// ---------- Case 2: compile error clears the in-flight flag.
// A subsequent doc-update must produce a fresh compile call,
// not be wedged behind a stale gate. ----------
{
  const { app, manual } = await bootCoalescerServer();
  const { ws, frames, clientDoc, text } = await bootClient(app, "err");

  await waitFor(
    () => manual.calls.length === 1,
    "initial compile call landed",
    frames,
  );

  // Initial compile fails.
  manual.calls[0].resolveError("synthetic compile failure");

  // Wait for the error frame so we know the in-flight flag has
  // had its `.finally` chance to clear.
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "error",
      ),
    "compile-status:error frame after synthetic failure",
    frames,
  );

  // Drive a doc-update; a fresh compile call must follow.
  const before = Y.encodeStateVector(clientDoc);
  text.insert(text.length, "after-error");
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc, before)));

  await waitFor(
    () => manual.calls.length === 2,
    "doc-update after error triggers a fresh compile",
    frames,
  );

  manual.calls[1].resolveSuccess(1);

  await closeClient(ws, app);
}

// ---------- Case 3: view-only fire-through. A `view` frame for a
// page above `highestEmittedShipoutPage` triggers a compile even
// with no doc-update. A `view` frame below it does NOT. ----------
{
  const { app, manual } = await bootCoalescerServer();
  const { ws, frames } = await bootClient(app, "view");

  await waitFor(
    () => manual.calls.length === 1,
    "initial compile call landed",
    frames,
  );

  // Initial compile finishes with shipoutPage=2.
  manual.calls[0].resolveSuccess(2);

  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "idle",
      ),
    "compile-status:idle after initial compile",
    frames,
  );

  // View page=2: not strictly greater than highest emitted → no kick.
  ws.send(encodeControl({ type: "view", page: 2 }));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    manual.calls.length,
    1,
    "view-frame to an already-shipped page must not re-fire compile",
  );

  // View page=5: above highest emitted → should kick a compile.
  ws.send(encodeControl({ type: "view", page: 5 }));
  await waitFor(
    () => manual.calls.length === 2,
    "view-frame above highest shipout fires through to compiler",
    frames,
  );

  manual.calls[1].resolveSuccess(5);

  await closeClient(ws, app);
}

// ---------- Case 4: no follow-up when no further updates arrive
// during the in-flight compile. Initial compile + finish → quiet. ----------
{
  const { app, manual } = await bootCoalescerServer();
  const { ws, frames } = await bootClient(app, "quiet");

  await waitFor(
    () => manual.calls.length === 1,
    "initial compile call landed",
    frames,
  );

  manual.calls[0].resolveSuccess(1);

  // Wait long past the debounce + finally re-schedule window.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    manual.calls.length,
    1,
    "no follow-up compile when nothing kicks while the first is in flight",
  );

  await closeClient(ws, app);
}

console.log("sidecar compile-coalescer test: OK");
