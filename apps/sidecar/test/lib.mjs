// Shared helpers for sidecar server tests. Each WS-driven test
// previously inlined identical `waitFor` and `bootClient`
// definitions; this file is the single source of truth.

import { WebSocket } from "ws";
import * as Y from "yjs";

import { MAIN_DOC_NAME, decodeFrame } from "../../../packages/protocol/src/index.ts";

export async function waitFor(check, label, frames) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: ${label}; frames=${JSON.stringify(frames.map((f) => f.kind))}`);
}

export async function bootClient(app, projectId) {
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
