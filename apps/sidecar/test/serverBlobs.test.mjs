// Sidecar wiring of `BlobStore` (M4.3.2). Boots a server with a
// `LocalFsBlobStore`, verifies:
//   1. A pre-populated `projects/<id>/files/main.tex` is hydrated
//      into the project's Y.Text and shipped to the first client.
//   2. An edit driven through Yjs is persisted back to the same
//      blob key after the next compile.
//   3. After server restart against the same blob root, the new
//      content is still there.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { MAIN_DOC_NAME, decodeFrame, encodeDocUpdate } from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-blob-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "alpha";
const initial = "\\documentclass{article}\\begin{document}hello\\end{document}";
await blobStore.put(`projects/${projectId}/files/main.tex`, new TextEncoder().encode(initial));

async function waitFor(check, label, frames) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: ${label}; frames=${JSON.stringify(frames.map((f) => f.kind))}`);
}

async function bootClient(app) {
  const address = app.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/project/${projectId}`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const clientDoc = new Y.Doc();
  const text = clientDoc.getText(MAIN_DOC_NAME);
  ws.on("message", (data) => {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const f = decodeFrame(buf);
    frames.push(f);
    if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return { ws, frames, clientDoc, text };
}

// --- Run 1: hydrate, edit, persist ---------------------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, text } = await bootClient(app);
  await waitFor(() => text.toString() === initial, "hydrated initial", frames);

  // Drive an edit through the same Yjs doc the test client holds —
  // produce a delta against current state and ship it. The server
  // applies but doesn't echo back to the originator, so we only
  // assert against the blob.
  const target = `${initial}\n% extra line`;
  const before = Y.encodeStateVector(text.doc);
  text.doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, target);
  });
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(text.doc, before)));

  await waitFor(async () => {
    const persisted = await blobStore.get(`projects/${projectId}/files/main.tex`);
    return persisted && new TextDecoder().decode(persisted) === target;
  }, "blob updated", frames);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold-start hydration sees the persisted edit -----------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, text } = await bootClient(app);
  const expected = `${initial}\n% extra line`;
  await waitFor(() => text.toString() === expected, "rehydrated edit", frames);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar blob wiring test: OK");
