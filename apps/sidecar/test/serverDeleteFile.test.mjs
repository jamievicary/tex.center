// Sidecar `delete-file` control message.
// Verifies: client requests deletion, server removes the blob,
// broadcasts a refreshed file-list, and rejects illegal deletes
// (main.tex, unknown name). After a server restart, the deleted
// file does not reappear.

import assert from "node:assert/strict";
import {
  MAIN_DOC_NAME,
  encodeControl,
} from "../../../packages/protocol/src/index.ts";
import {
  bootClient,
  closeClient,
  fileListFrames,
  isFileListFrame,
  latestFileList,
  makeBlobStore,
  seedFile,
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("delete-file");
const projectId = "deletable";
await seedMainTex(blobStore, projectId);
await seedFile(blobStore, projectId, "refs.bib", "@book{a,title={t}}");

// --- Run 1: delete refs.bib via the protocol -----------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames } = await bootClient(app, projectId);

  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("refs.bib")),
    "initial file-list with refs.bib",
    frames,
  );

  const fileListsBefore = fileListFrames(frames).length;

  // Reject: deleting main.tex.
  ws.send(encodeControl({ type: "delete-file", name: MAIN_DOC_NAME }));
  // Reject: deleting an unknown file.
  ws.send(encodeControl({ type: "delete-file", name: "ghost.tex" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    fileListFrames(frames).length,
    fileListsBefore,
    "rejected deletes must not broadcast a new file-list",
  );

  // Accept: delete refs.bib.
  ws.send(encodeControl({ type: "delete-file", name: "refs.bib" }));

  await waitFor(
    () => {
      const latest = latestFileList(frames);
      return latest && !latest.message.files.includes("refs.bib");
    },
    "post-delete file-list without refs.bib",
    frames,
  );
  assert.deepEqual(latestFileList(frames).message.files, [MAIN_DOC_NAME]);

  // Blob is gone.
  const persisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(persisted, null, "expected refs.bib blob to be removed");

  await closeClient(ws, app);
}

// --- Run 2: cold restart does not resurrect refs.bib ---------------
{
  const app = await startServer({ blobStore });
  const { ws, frames } = await bootClient(app, projectId);

  await waitFor(() => frames.some(isFileListFrame), "post-restart file-list", frames);
  assert.deepEqual(latestFileList(frames).message.files, [MAIN_DOC_NAME]);

  await closeClient(ws, app);
}

console.log("sidecar delete-file test: OK");
