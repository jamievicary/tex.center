// Iter 372 / M21 iter B: `runCompile` now requests `targetPage`
// from `maxViewingPage(p)` (clamped ≥1) rather than the legacy
// hardcoded 0 (`recompile,end`). This test pins both the cold-open
// default (no viewer-reported `viewingPage` → targetPage=1) and the
// post-`view` path (a `view` control frame promotes subsequent
// compiles to the reported page). Without the pin, a regression to
// the old `targetPage: 0` would silently re-enable the
// "every edit recompiles the whole document" cost surfaced by
// `.autodev/discussion/369b_question.md`.

import assert from "node:assert/strict";

import * as Y from "yjs";

import {
  encodeControl,
  encodeDocUpdate,
} from "../../../packages/protocol/src/index.ts";

import { bootClient, closeClient, startServer, waitFor } from "./lib.mjs";

const TINY_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

class RecordingCompiler {
  constructor() {
    this.calls = [];
  }
  async compile(req) {
    this.calls.push({
      targetPage: req.targetPage,
      sourceLen: req.source.length,
    });
    return {
      ok: true,
      segments: [
        { totalLength: TINY_PDF.length, offset: 0, bytes: TINY_PDF },
      ],
      // Mirror the daemon: the highest emitted shipout equals the
      // requested target when one is set, else 1.
      shipoutPage: req.targetPage > 0 ? req.targetPage : 1,
    };
  }
  async close() {}
  async warmup() {}
  async snapshot() {
    return null;
  }
  async restore() {}
}

// Case 1: cold open, no viewer-reported viewingPage. `maxViewingPage`
// defaults to 1, so the first compile is `targetPage=1`. This case
// is also the regression guard for the old `targetPage: 0` hardcode.
{
  const compiler = new RecordingCompiler();
  const app = await startServer({ compilerFactory: () => compiler });
  const { ws, frames } = await bootClient(app, "cold");

  await waitFor(
    () => compiler.calls.length >= 1,
    "initial compile call landed on RecordingCompiler",
    frames,
  );

  assert.equal(
    compiler.calls[0].targetPage,
    1,
    `cold-open compile must use targetPage=1 (maxViewingPage default), ` +
      `got ${compiler.calls[0].targetPage}. A regression to 0 would re-` +
      `enable the iter-369b "full-document compile on every edit" bug.`,
  );

  await closeClient(ws, app);
  console.log("ok 1 — cold open: targetPage=1");
}

// Case 2: a `view` frame with page=4 promotes subsequent compiles to
// targetPage=4 — both the immediate view-fired compile (since 4 >
// initial highestEmittedShipoutPage=1) and the next edit-driven
// compile (viewingPage state is sticky on the per-client record).
{
  const compiler = new RecordingCompiler();
  const app = await startServer({ compilerFactory: () => compiler });
  const { ws, frames, clientDoc, text } = await bootClient(app, "view4");

  await waitFor(
    () => compiler.calls.length >= 1,
    "initial compile call landed",
    frames,
  );

  ws.send(encodeControl({ type: "view", page: 4 }));

  await waitFor(
    () => compiler.calls.length >= 2,
    "view-fired compile lands",
    frames,
  );
  assert.equal(
    compiler.calls[1].targetPage,
    4,
    `view-driven compile must use targetPage=4, got ${compiler.calls[1].targetPage}`,
  );

  // Drive an edit; the next compile carries the same sticky
  // viewingPage. Without sticky semantics, an edit after a `view`
  // would re-default to page 1 and re-introduce the wedge described
  // in M15 / 369b.
  const before = Y.encodeStateVector(clientDoc);
  text.insert(text.length, "x");
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc, before)));

  await waitFor(
    () => compiler.calls.length >= 3,
    "edit-driven compile after view lands",
    frames,
  );
  assert.equal(
    compiler.calls[2].targetPage,
    4,
    `edit-driven compile after view=4 must use targetPage=4 ` +
      `(sticky), got ${compiler.calls[2].targetPage}`,
  );

  await closeClient(ws, app);
  console.log("ok 2 — view=4 promotes subsequent compiles to targetPage=4");
}

console.log("serverTargetPage.test.mjs: PASS");
