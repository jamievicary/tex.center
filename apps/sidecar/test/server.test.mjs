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

import {
  MAIN_DOC_HELLO_WORLD,
  MAIN_DOC_NAME,
  decodeFrame,
  encodeDocUpdate,
} from "../../../packages/protocol/src/index.ts";
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

// Default (no blobStore) file-list contains just main.tex.
const fileListFrame = frames.find(
  (f) => f.kind === "control" && f.message.type === "file-list",
);
assert.ok(fileListFrame, "expected file-list control frame");
assert.deepEqual(fileListFrame.message.files, ["main.tex"]);

const pdfFrame = frames.find((f) => f.kind === "pdf-segment");
assert.ok(pdfFrame.segment.totalLength > 0);
assert.equal(pdfFrame.segment.offset, 0);
assert.equal(pdfFrame.segment.bytes.length, pdfFrame.segment.totalLength);
assert.equal(String.fromCharCode(...pdfFrame.segment.bytes.slice(0, 4)), "%PDF");

// The initial compile mirrored the seeded hello-world template
// (iter 167) to disk — a brand-new in-memory project opens onto
// the canonical 4-line LaTeX boilerplate rather than an empty
// buffer.
const mainTexPath = join(scratchRoot, projectId, "main.tex");
await waitForCondition(() => existsSync(mainTexPath), "main.tex creation");
await waitForCondition(
  () => readFileSync(mainTexPath, "utf8") === MAIN_DOC_HELLO_WORLD,
  "main.tex initial seed",
);

// Drive an edit through Yjs and confirm the mirrored file picks it up.
// First sync the client doc by applying every doc-update frame the
// server has sent so far (these carry the seeded template), then
// append a user edit. Without the sync step the client's insert
// would race the server's seed insert as a concurrent operation
// and the merged order would be clientID-dependent.
const clientDoc = new Y.Doc();
for (const f of frames) {
  if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
}
assert.equal(
  clientDoc.getText(MAIN_DOC_NAME).toString(),
  MAIN_DOC_HELLO_WORLD,
  "client doc should have synced the seeded template",
);
const appended = " % user note";
clientDoc.getText(MAIN_DOC_NAME).insert(MAIN_DOC_HELLO_WORLD.length, appended);
const update = Y.encodeStateAsUpdate(clientDoc);
ws.send(encodeDocUpdate(update));

const expectedAfter = MAIN_DOC_HELLO_WORLD + appended;
await waitForCondition(
  () => readFileSync(mainTexPath, "utf8") === expectedAfter,
  "main.tex mirror update",
);

ws.close();
await new Promise((r) => ws.once("close", r));
await app.close();

// Externally-supplied scratchRoot persists; per-project subdir is removed.
assert.equal(existsSync(scratchRoot), true);
assert.equal(existsSync(join(scratchRoot, projectId)), false);

console.log("sidecar server test: OK");
