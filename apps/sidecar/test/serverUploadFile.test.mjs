// Sidecar `upload-file` control message.
// Verifies: client uploads a text file's contents, server adds it
// to knownFiles, PUTs a blob carrying those bytes, broadcasts a
// refreshed file-list, and populates the corresponding Y.Text.
// Server-side rejections (duplicate, invalid name) produce a
// `file-op-error` frame to the originator. A second sidecar
// pointed at the same blob root rehydrates the uploaded file with
// its content intact.

import assert from "node:assert/strict";
import {
  MAIN_DOC_NAME,
  encodeControl,
} from "../../../packages/protocol/src/index.ts";
import {
  bootClient,
  closeClient,
  fileListFrames,
  fileOpErrors,
  isFileListFrame,
  latestFileList,
  makeBlobStore,
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("upload-file");
const projectId = "uploadable";
// Seed a main.tex so hydration succeeds (canPersist=true).
await seedMainTex(blobStore, projectId);

const REFS_BIB = "@book{lamport1986latex,\n  title={LaTeX},\n  author={Lamport, L}\n}\n";

// --- Run 1: upload via the protocol -----------------------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames, clientDoc } = await bootClient(app, projectId);

  // Wait for initial file-list (main.tex only).
  await waitFor(() => frames.some(isFileListFrame), "initial file-list", frames);
  assert.deepEqual(latestFileList(frames).message.files, [MAIN_DOC_NAME]);

  // Upload a new file.
  ws.send(encodeControl({ type: "upload-file", name: "refs.bib", content: REFS_BIB }));

  // File-list updates to include the new entry.
  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("refs.bib")),
    "post-upload file-list",
    frames,
  );
  assert.deepEqual(latestFileList(frames).message.files, ["main.tex", "refs.bib"]);

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
    () => fileOpErrors(frames).length >= 2,
    "two file-op-error frames",
    frames,
  );
  for (const e of fileOpErrors(frames)) {
    assert.equal(e.message.op, "upload-file");
    assert.ok(e.message.reason && e.message.reason.length > 0);
  }

  // The blob was not overwritten by the duplicate attempt.
  const stillPersisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(new TextDecoder().decode(stillPersisted), REFS_BIB);

  await closeClient(ws, app);
}

// --- Run 2: cold restart sees the uploaded file -----------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames, clientDoc } = await bootClient(app, projectId);

  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("refs.bib")),
    "refs.bib hydrated on restart",
    frames,
  );
  await waitFor(
    () => clientDoc.getText("refs.bib").toString() === REFS_BIB,
    "refs.bib content hydrated",
    frames,
  );

  await closeClient(ws, app);
}

console.log("sidecar upload-file test: OK");
