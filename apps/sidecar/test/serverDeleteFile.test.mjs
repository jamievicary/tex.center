// Sidecar `delete-file` control message.
// Verifies: client requests deletion, server removes the blob,
// broadcasts a refreshed file-list, and rejects illegal deletes
// (main.tex, unknown name). After a server restart, the deleted
// file does not reappear.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import {
  MAIN_DOC_NAME,
  decodeFrame,
  encodeControl,
} from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-delete-file-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "deletable";
const enc = new TextEncoder();
await blobStore.put(
  `projects/${projectId}/files/main.tex`,
  enc.encode("\\documentclass{article}\\begin{document}x\\end{document}"),
);
await blobStore.put(
  `projects/${projectId}/files/refs.bib`,
  enc.encode("@book{a,title={t}}"),
);

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
  ws.on("message", (data) => {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const f = decodeFrame(buf);
    frames.push(f);
    if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return { ws, frames, clientDoc };
}

// --- Run 1: delete refs.bib via the protocol -----------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames } = await bootClient(app);

  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.includes("refs.bib"),
      ),
    "initial file-list with refs.bib",
    frames,
  );

  const fileListsBefore = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-list",
  ).length;

  // Reject: deleting main.tex.
  ws.send(encodeControl({ type: "delete-file", name: MAIN_DOC_NAME }));
  // Reject: deleting an unknown file.
  ws.send(encodeControl({ type: "delete-file", name: "ghost.tex" }));
  await new Promise((r) => setTimeout(r, 100));
  const fileListsAfterRejects = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-list",
  ).length;
  assert.equal(
    fileListsAfterRejects,
    fileListsBefore,
    "rejected deletes must not broadcast a new file-list",
  );

  // Accept: delete refs.bib.
  ws.send(encodeControl({ type: "delete-file", name: "refs.bib" }));

  await waitFor(
    () =>
      [...frames].reverse().some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          !f.message.files.includes("refs.bib"),
      ),
    "post-delete file-list without refs.bib",
    frames,
  );
  const latest = [...frames]
    .reverse()
    .find((f) => f.kind === "control" && f.message.type === "file-list");
  assert.deepEqual(latest.message.files, [MAIN_DOC_NAME]);

  // Blob is gone.
  const persisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(persisted, null, "expected refs.bib blob to be removed");

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold restart does not resurrect refs.bib ---------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames } = await bootClient(app);

  await waitFor(
    () =>
      frames.some(
        (f) => f.kind === "control" && f.message.type === "file-list",
      ),
    "post-restart file-list",
    frames,
  );
  const fileList = frames.find(
    (f) => f.kind === "control" && f.message.type === "file-list",
  );
  assert.deepEqual(fileList.message.files, [MAIN_DOC_NAME]);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar delete-file test: OK");
