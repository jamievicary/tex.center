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
import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import {
  MAIN_DOC_NAME,
  encodeControl,
} from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";
import { bootClient, waitFor } from "./lib.mjs";

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

// --- Run 1: rename refs.bib -> bibliography.bib --------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc } = await bootClient(app, projectId);

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
  await waitFor(
    () =>
      frames.filter(
        (f) => f.kind === "control" && f.message.type === "file-op-error",
      ).length >= 4,
    "four file-op-error frames for the four rejected renames",
    frames,
  );
  const fileListsAfterRejects = frames.filter(
    (f) => f.kind === "control" && f.message.type === "file-list",
  ).length;
  assert.equal(
    fileListsAfterRejects,
    fileListsBefore,
    "rejected renames must not broadcast a new file-list",
  );
  const opErrors = frames
    .filter((f) => f.kind === "control" && f.message.type === "file-op-error")
    .map((f) => f.message);
  for (const e of opErrors) {
    assert.equal(e.op, "rename-file");
    assert.equal(typeof e.reason, "string");
    assert.ok(e.reason.length > 0, `non-empty reason; got ${JSON.stringify(e)}`);
  }

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

  const { ws, frames, clientDoc } = await bootClient(app, projectId);

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
