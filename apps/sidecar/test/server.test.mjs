// Boots the sidecar on an ephemeral port, connects a WebSocket
// client, and verifies it receives a hello + PDF segment from
// the stub compile loop. Also checks the on-disk workspace
// mirror reflects edits and is cleaned up on shutdown.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { MAIN_DOC_NAME, decodeFrame, encodeDocUpdate } from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-srv-test-"));
const app = await buildServer({ logger: false, scratchRoot });
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("listen() returned no address info");
}
const port = address.port;

const projectId = "test";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${projectId}`);
ws.binaryType = "arraybuffer";

const frames = [];

function waitForCondition(check, label) {
  const deadline = Date.now() + 5000;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}; frames=${JSON.stringify(frames.map((f) => f.kind))}`));
      }
    }, 25);
  });
}

ws.on("error", (e) => {
  throw e;
});
ws.on("message", (data, isBinary) => {
  assert.ok(isBinary, "expected binary frame");
  const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  frames.push(decodeFrame(buf));
});

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

await waitForCondition(() => {
  const hasHello = frames.some((f) => f.kind === "control" && f.message.type === "hello");
  const hasPdf = frames.some((f) => f.kind === "pdf-segment");
  const hasIdle = frames.some(
    (f) => f.kind === "control" && f.message.type === "compile-status" && f.message.state === "idle",
  );
  return hasHello && hasPdf && hasIdle;
}, "initial compile cycle");

const pdfFrame = frames.find((f) => f.kind === "pdf-segment");
assert.ok(pdfFrame.segment.totalLength > 0);
assert.equal(pdfFrame.segment.offset, 0);
assert.equal(pdfFrame.segment.bytes.length, pdfFrame.segment.totalLength);
assert.equal(String.fromCharCode(...pdfFrame.segment.bytes.slice(0, 4)), "%PDF");

// The initial compile mirrored an empty Y.Text to disk.
const mainTexPath = join(scratchRoot, projectId, "main.tex");
await waitForCondition(() => existsSync(mainTexPath), "main.tex creation");
assert.equal(readFileSync(mainTexPath, "utf8"), "");

// Drive an edit through Yjs and confirm the mirrored file picks it up.
const clientDoc = new Y.Doc();
clientDoc.getText(MAIN_DOC_NAME).insert(0, "hello from the client");
const update = Y.encodeStateAsUpdate(clientDoc);
ws.send(encodeDocUpdate(update));

await waitForCondition(
  () => readFileSync(mainTexPath, "utf8") === "hello from the client",
  "main.tex mirror update",
);

ws.close();
await new Promise((r) => ws.once("close", r));
await app.close();

// Externally-supplied scratchRoot persists; per-project subdir is removed.
assert.equal(existsSync(scratchRoot), true);
assert.equal(existsSync(join(scratchRoot, projectId)), false);

console.log("sidecar server test: OK");
