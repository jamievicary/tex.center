// Sidecar `rename-file` control message.
// Verifies: rejects illegal renames (main.tex on either side,
// unknown source, duplicate target, invalid name); on success
// the doc-update carries the new file's contents, the file-list
// reflects the rename, the old blob is gone, the new blob has
// the original contents, and a cold restart shows the renamed
// file with contents intact (no resurrection of the old name).

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

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-rename-file-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "renameable";
const enc = new TextEncoder();
const REFS_SOURCE = "@book{a,title={t}}";
await blobStore.put(
  `projects/${projectId}/files/main.tex`,
  enc.encode("\\documentclass{article}\\begin{document}x\\end{document}"),
);
await blobStore.put(
  `projects/${projectId}/files/refs.bib`,
  enc.encode(REFS_SOURCE),
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

// --- Run 1: rename refs.bib -> bibliography.bib --------------------
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
    "initial file-list with refs.bib",
    frames,
  );

  const fileListsBefore = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-list",
  ).length;

  // Rejects.
  ws.send(encodeControl({ type: "rename-file", oldName: MAIN_DOC_NAME, newName: "x.tex" }));
  ws.send(encodeControl({ type: "rename-file", oldName: "refs.bib", newName: MAIN_DOC_NAME }));
  ws.send(encodeControl({ type: "rename-file", oldName: "ghost.tex", newName: "y.tex" }));
  ws.send(encodeControl({ type: "rename-file", oldName: "refs.bib", newName: "bad/name" }));
  await new Promise((r) => setTimeout(r, 100));
  const fileListsAfterRejects = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-list",
  ).length;
  assert.equal(
    fileListsAfterRejects,
    fileListsBefore,
    "rejected renames must not broadcast a new file-list",
  );

  // Accept: rename.
  ws.send(
    encodeControl({ type: "rename-file", oldName: "refs.bib", newName: "bibliography.bib" }),
  );

  await waitFor(
    () =>
      [...frames].reverse().some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.includes("bibliography.bib") &&
          !f.message.files.includes("refs.bib"),
      ),
    "post-rename file-list",
    frames,
  );
  const latest = [...frames]
    .reverse()
    .find((f) => f.kind === "control" && f.message.type === "file-list");
  assert.deepEqual(latest.message.files, ["bibliography.bib", MAIN_DOC_NAME]);

  // Client doc carries the new contents and the old is empty.
  assert.equal(clientDoc.getText("bibliography.bib").toString(), REFS_SOURCE);
  assert.equal(clientDoc.getText("refs.bib").toString(), "");

  // Blob is renamed.
  const oldBlob = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(oldBlob, null, "expected old blob to be removed");
  const newBlob = await blobStore.get(`projects/${projectId}/files/bibliography.bib`);
  assert.ok(newBlob, "expected new blob to exist");
  assert.equal(new TextDecoder().decode(newBlob), REFS_SOURCE);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold restart shows only the renamed file ---------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc } = await bootClient(app);

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
  assert.deepEqual(fileList.message.files, ["bibliography.bib", MAIN_DOC_NAME]);

  // Wait for the doc-update carrying hydrated contents.
  await waitFor(
    () => clientDoc.getText("bibliography.bib").toString() === REFS_SOURCE,
    "hydrated contents on renamed file",
    frames,
  );

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar rename-file test: OK");
