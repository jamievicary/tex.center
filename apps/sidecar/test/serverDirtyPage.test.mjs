// Server-level pin for the M27 dirty-page wire path. Boots the
// sidecar against a mock compiler that returns a CompileResult
// carrying `dirtyPage`, and asserts:
//
//   1. After the segment, the server broadcasts a `dirty-page`
//      control frame whose `page` equals `result.dirtyPage`.
//   2. Compiles without a `dirtyPage` (vanilla view-only advance)
//      do NOT emit a `dirty-page` frame.
//
// The real `[dirty D]` parsing path is covered by
// `tests_gold/lib/test/supertexDaemonReal.test.mjs`; this test
// isolates the sidecar plumbing between `CompileResult.dirtyPage`
// and the wire so a regression in the broadcast wiring surfaces
// without needing TeX Live on the test host.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import {
  MAIN_DOC_HELLO_WORLD,
  MAIN_DOC_NAME,
  decodeFrame,
  encodeDocUpdate,
} from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

// Mock compiler whose behaviour is dictated by an external script.
// Each call shifts one result off the queue (or repeats the last one).
function makeMockCompilerFactory(queue) {
  let last = null;
  return () => ({
    supportsCheckpoint: false,
    async warmup() {},
    async snapshot() {
      return null;
    },
    async restore() {},
    async close() {},
    async compile(_req) {
      const next = queue.length > 0 ? queue.shift() : last;
      if (!next) throw new Error("mock compiler queue exhausted");
      last = next;
      return next;
    },
  });
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a]);

const dirtyResult = {
  ok: true,
  segments: [
    {
      totalLength: PDF_BYTES.length,
      offset: 0,
      bytes: PDF_BYTES,
      shipoutPage: 3,
      lastPage: false,
    },
  ],
  shipoutPage: 3,
  lastPage: false,
  dirtyPage: 1,
};
const cleanResult = {
  ok: true,
  segments: [
    {
      totalLength: PDF_BYTES.length,
      offset: 0,
      bytes: PDF_BYTES,
      shipoutPage: 4,
      lastPage: false,
    },
  ],
  shipoutPage: 4,
  lastPage: false,
};

const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-dirty-test-"));
const queue = [dirtyResult, cleanResult];
const app = await buildServer({
  logger: false,
  scratchRoot,
  compilerFactory: makeMockCompilerFactory(queue),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("listen() returned no address info");
}
const port = address.port;

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/test`);
ws.binaryType = "arraybuffer";

const frames = [];
ws.on("error", (e) => {
  throw e;
});
ws.on("message", (data) => {
  const buf =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  frames.push(decodeFrame(buf));
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

function waitFor(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(
          new Error(
            `timeout waiting for ${label}; frames=${JSON.stringify(
              frames.map((f) =>
                f.kind === "control" ? `control:${f.message.type}` : f.kind,
              ),
            )}`,
          ),
        );
      }
    }, 20);
  });
}

// First compile is the dirty one. Expect a pdf-segment frame
// followed by a dirty-page control frame whose page === 1.
await waitFor(
  () =>
    frames.some(
      (f) => f.kind === "control" && f.message.type === "dirty-page",
    ),
  "first dirty-page broadcast",
);

const dirtyIdx = frames.findIndex(
  (f) => f.kind === "control" && f.message.type === "dirty-page",
);
const dirtyFrame = frames[dirtyIdx];
assert.equal(dirtyFrame.message.type, "dirty-page");
assert.equal(dirtyFrame.message.page, 1, "page mirrors result.dirtyPage");

// The segment must precede the dirty-page (the M27 wire contract:
// chunks first, dirty marker after, so the FE can combine).
const segIdx = frames.findIndex((f) => f.kind === "pdf-segment");
assert.ok(segIdx >= 0, "pdf-segment broadcast on first compile");
assert.ok(
  segIdx < dirtyIdx,
  "pdf-segment must precede dirty-page in the same compile round",
);

// Drive a second compile via a doc-update. The mock returns
// `cleanResult` (no dirtyPage) → server must NOT emit any further
// dirty-page frame. We wait for the second pdf-segment, then take
// a snapshot of dirty-page count before and after, plus a small
// settle window to catch any straggler.
const dirtyCountBefore = frames.filter(
  (f) => f.kind === "control" && f.message.type === "dirty-page",
).length;

const clientDoc = new Y.Doc();
for (const f of frames) if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
clientDoc
  .getText(MAIN_DOC_NAME)
  .insert(MAIN_DOC_HELLO_WORLD.length, " %edit-no-dirty");
ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc)));

const segCountBefore = frames.filter((f) => f.kind === "pdf-segment").length;
await waitFor(
  () => frames.filter((f) => f.kind === "pdf-segment").length > segCountBefore,
  "second pdf-segment after edit",
);
// Settle for any trailing dirty-page that should NOT exist.
await new Promise((r) => setTimeout(r, 150));
const dirtyCountAfter = frames.filter(
  (f) => f.kind === "control" && f.message.type === "dirty-page",
).length;
assert.equal(
  dirtyCountAfter,
  dirtyCountBefore,
  "clean compile (no dirtyPage) must not broadcast a dirty-page frame",
);

ws.close();
await app.close();
console.log("serverDirtyPage: ok");
