// Sidecar `upload-file` control message.
// Verifies: client uploads a text file's contents, server adds it
// to knownFiles, PUTs a blob carrying those bytes, broadcasts a
// refreshed file-list, and populates the corresponding Y.Text.
// Server-side rejections (duplicate, invalid name) produce a
// `file-op-error` frame to the originator. A second sidecar
// pointed at the same blob root rehydrates the uploaded file with
// its content intact.

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

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-upload-file-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "uploadable";
// Seed a main.tex so hydration succeeds (canPersist=true).
await blobStore.put(
  `projects/${projectId}/files/main.tex`,
  new TextEncoder().encode("\\documentclass{article}\\begin{document}x\\end{document}"),
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

const REFS_BIB = "@book{lamport1986latex,\n  title={LaTeX},\n  author={Lamport, L}\n}\n";

// --- Run 1: upload via the protocol -----------------------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc } = await bootClient(app);

  // Wait for initial file-list (main.tex only).
  await waitFor(
    () => frames.some((f) => f.kind === "control" && f.message.type === "file-list"),
    "initial file-list",
    frames,
  );
  const firstFileList = frames.find(
    (f) => f.kind === "control" && f.message.type === "file-list",
  );
  assert.deepEqual(firstFileList.message.files, [MAIN_DOC_NAME]);

  // Upload a new file.
  ws.send(encodeControl({ type: "upload-file", name: "refs.bib", content: REFS_BIB }));

  // File-list updates to include the new entry.
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.includes("refs.bib"),
      ),
    "post-upload file-list",
    frames,
  );
  const fileListWithNew = [...frames]
    .reverse()
    .find((f) => f.kind === "control" && f.message.type === "file-list");
  assert.deepEqual(fileListWithNew.message.files, ["main.tex", "refs.bib"]);

  // The Y.Text for refs.bib carries the uploaded content.
  await waitFor(
    () => clientDoc.getText("refs.bib").toString() === REFS_BIB,
    "refs.bib Y.Text populated",
    frames,
  );
  assert.equal(clientDoc.getText("refs.bib").toString(), REFS_BIB);

  // The blob holds the uploaded bytes.
  const persisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.ok(persisted, "expected refs.bib blob to exist");
  assert.equal(new TextDecoder().decode(persisted), REFS_BIB);

  // Duplicate upload is rejected with a file-op-error.
  ws.send(encodeControl({ type: "upload-file", name: "refs.bib", content: "different" }));
  // Invalid name is also rejected.
  ws.send(encodeControl({ type: "upload-file", name: "../escape", content: "x" }));

  await waitFor(
    () =>
      frames.filter(
        (f) => f.kind === "control" && f.message.type === "file-op-error",
      ).length >= 2,
    "two file-op-error frames",
    frames,
  );
  const errs = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-op-error",
  );
  for (const e of errs) {
    assert.equal(e.message.op, "upload-file");
    assert.ok(e.message.reason && e.message.reason.length > 0);
  }

  // The blob was not overwritten by the duplicate attempt.
  const stillPersisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(new TextDecoder().decode(stillPersisted), REFS_BIB);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold restart sees the uploaded file -----------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc } = await bootClient(app);

  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.includes("refs.bib"),
      ),
    "refs.bib hydrated on restart",
    frames,
  );
  await waitFor(
    () => clientDoc.getText("refs.bib").toString() === REFS_BIB,
    "refs.bib content hydrated",
    frames,
  );

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar upload-file test: OK");
