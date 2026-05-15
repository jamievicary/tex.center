// M23.5 — lock in-place Y.Text edit mirror for non-main files.
// A remote (client-applied) `Y.Doc` update on a non-main file must
// reach the on-disk workspace via the per-file `Y.Text.observe`
// subscription. Three scenarios:
//
//   1. Hydrate-then-edit: server boots with `sec1.tex` pre-seeded in
//      the blob store; the hydration block writes it to disk AND
//      subscribes the observer; a client edit on `sec1.tex` lands
//      on disk without any structural file-op.
//   2. Add-then-edit: client creates `notes.tex` via `create-file`,
//      then sends a doc-update that inserts body text; the
//      observer subscribed in `addFile` carries the edit to disk.
//   3. Rename-resubscribe: client renames `notes.tex`→`notes2.tex`,
//      then edits `notes2.tex`; the observer is re-subscribed under
//      the new name and the edit lands at the new path (not the old).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";

import {
  encodeControl,
  encodeDocUpdate,
} from "../../../packages/protocol/src/index.ts";
import {
  bootClient,
  closeClient,
  fileListFrames,
  isFileListFrame,
  makeBlobStore,
  seedFile,
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("workspace-observe");
const projectId = "observe-proj";
const SEC1_INITIAL = "% initial sec1\nbody\n";
await seedMainTex(blobStore, projectId);
await seedFile(blobStore, projectId, "sec1.tex", SEC1_INITIAL);

const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-observe-scratch-"));
const projectDir = join(scratchRoot, projectId);
const app = await startServer({ blobStore, scratchRoot });
const { ws, frames, clientDoc } = await bootClient(app, projectId);

// Forward client-edit updates only (tagged with origin "client-edit");
// server→client updates arrive with origin `undefined` via
// `Y.applyUpdate(clientDoc, f.update)` inside `bootClient` and must
// not be echoed back.
clientDoc.on("update", (update, origin) => {
  if (origin !== "client-edit") return;
  ws.send(encodeDocUpdate(update));
});

// (1) Hydrate-then-edit ----------------------------------------------
await waitFor(() => frames.some(isFileListFrame), "initial file-list", frames);
await waitFor(
  () => existsSync(join(projectDir, "sec1.tex")),
  "sec1.tex mirrored from hydration",
  frames,
);
assert.equal(readFileSync(join(projectDir, "sec1.tex"), "utf8"), SEC1_INITIAL);

const APPEND_SEC1 = "EXTRA SEC1 LINE\n";
clientDoc.transact(() => {
  clientDoc.getText("sec1.tex").insert(SEC1_INITIAL.length, APPEND_SEC1);
}, "client-edit");

await waitFor(
  () => {
    if (!existsSync(join(projectDir, "sec1.tex"))) return false;
    return (
      readFileSync(join(projectDir, "sec1.tex"), "utf8")
      === SEC1_INITIAL + APPEND_SEC1
    );
  },
  "sec1.tex on disk reflects client edit via Y.Text.observe",
  frames,
);

// (2) Add-then-edit --------------------------------------------------
ws.send(encodeControl({ type: "create-file", name: "notes.tex" }));
await waitFor(
  () => fileListFrames(frames).some((f) => f.message.files.includes("notes.tex")),
  "notes.tex in file-list",
  frames,
);
await waitFor(
  () => existsSync(join(projectDir, "notes.tex")),
  "notes.tex created on disk",
  frames,
);
assert.equal(readFileSync(join(projectDir, "notes.tex"), "utf8"), "");

const NOTES_BODY = "These are notes.\n";
clientDoc.transact(() => {
  clientDoc.getText("notes.tex").insert(0, NOTES_BODY);
}, "client-edit");

await waitFor(
  () => {
    if (!existsSync(join(projectDir, "notes.tex"))) return false;
    return readFileSync(join(projectDir, "notes.tex"), "utf8") === NOTES_BODY;
  },
  "notes.tex on disk reflects client edit after create-file",
  frames,
);

// (3) Rename-resubscribe --------------------------------------------
ws.send(encodeControl({
  type: "rename-file",
  oldName: "notes.tex",
  newName: "notes2.tex",
}));
await waitFor(
  () =>
    !existsSync(join(projectDir, "notes.tex"))
    && existsSync(join(projectDir, "notes2.tex")),
  "notes rename mirrored to disk",
  frames,
);
assert.equal(readFileSync(join(projectDir, "notes2.tex"), "utf8"), NOTES_BODY);

// Edit at the renamed path; current contents of the new Y.Text are
// `NOTES_BODY` (copied during rename). Append a marker line.
const MARK = "AFTER RENAME\n";
clientDoc.transact(() => {
  const t = clientDoc.getText("notes2.tex");
  t.insert(t.length, MARK);
}, "client-edit");

await waitFor(
  () => {
    if (!existsSync(join(projectDir, "notes2.tex"))) return false;
    return (
      readFileSync(join(projectDir, "notes2.tex"), "utf8")
      === NOTES_BODY + MARK
    );
  },
  "notes2.tex on disk reflects post-rename edit",
  frames,
);
assert.equal(
  existsSync(join(projectDir, "notes.tex")),
  false,
  "old notes.tex path stays deleted after post-rename edit",
);

// (4) Delete unsubscribe --------------------------------------------
// Edit the file once more *before* delete to seed an in-flight write,
// then delete; the file must be gone on disk and no later observer
// write may resurrect it.
clientDoc.transact(() => {
  clientDoc.getText("notes2.tex").insert(0, "ZZ\n");
}, "client-edit");

ws.send(encodeControl({ type: "delete-file", name: "notes2.tex" }));
await waitFor(
  () => !existsSync(join(projectDir, "notes2.tex")),
  "notes2.tex deleted from disk",
  frames,
);

// Even after a brief settle, the file stays gone.
await new Promise((r) => setTimeout(r, 50));
assert.equal(
  existsSync(join(projectDir, "notes2.tex")),
  false,
  "notes2.tex stays gone — no resurrecting observer write",
);

await closeClient(ws, app);
console.log("sidecar workspace observe-mirror test: OK");
