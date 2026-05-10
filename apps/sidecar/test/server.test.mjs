// Boots the sidecar on an ephemeral port, connects a WebSocket
// client, and verifies it receives a hello + PDF segment from
// the stub compile loop. Closes everything cleanly.

import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { decodeFrame } from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

const app = await buildServer({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("listen() returned no address info");
}
const port = address.port;

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/test`);
ws.binaryType = "arraybuffer";

const frames = [];
const deadline = Date.now() + 5000;

await new Promise((resolve, reject) => {
  ws.on("open", () => {});
  ws.on("error", reject);
  ws.on("message", (data, isBinary) => {
    assert.ok(isBinary, "expected binary frame");
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    frames.push(decodeFrame(buf));
    // We need: hello + compile-status running + pdf-segment + compile-status idle.
    const hasHello = frames.some(
      (f) => f.kind === "control" && f.message.type === "hello",
    );
    const hasPdf = frames.some((f) => f.kind === "pdf-segment");
    const hasIdle = frames.some(
      (f) =>
        f.kind === "control" &&
        f.message.type === "compile-status" &&
        f.message.state === "idle",
    );
    if (hasHello && hasPdf && hasIdle) resolve();
  });
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error(`timeout; frames so far: ${JSON.stringify(frames.map((f) => f.kind))}`));
    }
  }, 100);
});

const pdfFrame = frames.find((f) => f.kind === "pdf-segment");
assert.ok(pdfFrame.segment.totalLength > 0);
assert.equal(pdfFrame.segment.offset, 0);
assert.equal(pdfFrame.segment.bytes.length, pdfFrame.segment.totalLength);
// Should look like a PDF.
assert.equal(String.fromCharCode(...pdfFrame.segment.bytes.slice(0, 4)), "%PDF");

ws.close();
await new Promise((r) => ws.once("close", r));
await app.close();

console.log("sidecar server test: OK");
