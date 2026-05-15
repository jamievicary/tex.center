// Sidecar `rename-file` control message.
// Verifies: rejects illegal renames (main.tex on either side,
// unknown source, duplicate target, invalid name); on success
// the doc-update carries the new file's contents, the file-list
// reflects the rename, the old blob is gone, the new blob has
// the original contents, and a cold restart shows the renamed
// file with contents intact (no resurrection of the old name).

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
  seedFile,
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("rename-file");
const projectId = "renameable";
const REFS_SOURCE = "@book{a,title={t}}";
await seedMainTex(blobStore, projectId);
await seedFile(blobStore, projectId, "refs.bib", REFS_SOURCE);

// --- Run 1: rename refs.bib -> bibliography.bib --------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames, clientDoc } = await bootClient(app, projectId);

  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("refs.bib")),
    "initial file-list with refs.bib",
    frames,
  );

  const fileListsBefore = fileListFrames(frames).length;

  // Rejects.
  ws.send(encodeControl({ type: "rename-file", oldName: MAIN_DOC_NAME, newName: "x.tex" }));
  ws.send(encodeControl({ type: "rename-file", oldName: "refs.bib", newName: MAIN_DOC_NAME }));
  ws.send(encodeControl({ type: "rename-file", oldName: "ghost.tex", newName: "y.tex" }));
  ws.send(encodeControl({ type: "rename-file", oldName: "refs.bib", newName: "bad name" }));
  await waitFor(
    () => fileOpErrors(frames).length >= 4,
    "four file-op-error frames for the four rejected renames",
    frames,
  );
  assert.equal(
    fileListFrames(frames).length,
    fileListsBefore,
    "rejected renames must not broadcast a new file-list",
  );
  for (const e of fileOpErrors(frames).map((f) => f.message)) {
    assert.equal(e.op, "rename-file");
    assert.equal(typeof e.reason, "string");
    assert.ok(e.reason.length > 0, `non-empty reason; got ${JSON.stringify(e)}`);
  }

  // Accept: rename.
  ws.send(
    encodeControl({ type: "rename-file", oldName: "refs.bib", newName: "bibliography.bib" }),
  );

  await waitFor(
    () => {
      const latest = latestFileList(frames);
      return (
        latest &&
        latest.message.files.includes("bibliography.bib") &&
        !latest.message.files.includes("refs.bib")
      );
    },
    "post-rename file-list",
    frames,
  );
  assert.deepEqual(latestFileList(frames).message.files, ["bibliography.bib", MAIN_DOC_NAME]);

  // Client doc carries the new contents and the old is empty.
  assert.equal(clientDoc.getText("bibliography.bib").toString(), REFS_SOURCE);
  assert.equal(clientDoc.getText("refs.bib").toString(), "");

  // Blob is renamed.
  const oldBlob = await blobStore.get(`projects/${projectId}/files/refs.bib`);
  assert.equal(oldBlob, null, "expected old blob to be removed");
  const newBlob = await blobStore.get(`projects/${projectId}/files/bibliography.bib`);
  assert.ok(newBlob, "expected new blob to exist");
  assert.equal(new TextDecoder().decode(newBlob), REFS_SOURCE);

  await closeClient(ws, app);
}

// --- Run 2: cold restart shows only the renamed file ---------------
{
  const app = await startServer({ blobStore });
  const { ws, frames, clientDoc } = await bootClient(app, projectId);

  await waitFor(() => frames.some(isFileListFrame), "post-restart file-list", frames);
  assert.deepEqual(latestFileList(frames).message.files, ["bibliography.bib", MAIN_DOC_NAME]);

  // Wait for the doc-update carrying hydrated contents.
  await waitFor(
    () => clientDoc.getText("bibliography.bib").toString() === REFS_SOURCE,
    "hydrated contents on renamed file",
    frames,
  );

  await closeClient(ws, app);
}

console.log("sidecar rename-file test: OK");
