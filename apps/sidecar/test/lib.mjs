// Shared helpers for sidecar server tests. Each WS-driven test
// previously inlined identical `waitFor`/`bootClient` definitions
// plus identical blob-store setup, server boot, and file-list
// frame-filtering boilerplate. This file is the single source of
// truth for that scaffolding.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { MAIN_DOC_NAME, decodeFrame } from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

export const DEFAULT_MAIN_TEX =
  "\\documentclass{article}\\begin{document}x\\end{document}";

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

export function makeBlobStore(label) {
  const blobRoot = mkdtempSync(join(tmpdir(), `sidecar-${label}-test-`));
  return { blobStore: new LocalFsBlobStore({ rootDir: blobRoot }), blobRoot };
}

export async function seedFile(blobStore, projectId, name, content) {
  await blobStore.put(
    `projects/${projectId}/files/${name}`,
    new TextEncoder().encode(content),
  );
}

export async function seedMainTex(blobStore, projectId, content = DEFAULT_MAIN_TEX) {
  await seedFile(blobStore, projectId, "main.tex", content);
}

export async function startServer(opts) {
  const app = await buildServer({ logger: false, ...opts });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

export async function closeClient(ws, app) {
  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

export function isFileListFrame(f) {
  return f.kind === "control" && f.message.type === "file-list";
}

export function fileListFrames(frames) {
  return frames.filter(isFileListFrame);
}

export function latestFileList(frames) {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (isFileListFrame(frames[i])) return frames[i];
  }
  return undefined;
}

export function fileOpErrors(frames) {
  return frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-op-error",
  );
}
