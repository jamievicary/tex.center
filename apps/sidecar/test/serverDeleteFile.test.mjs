// Sidecar `delete-file` control message.
// Verifies: client requests deletion, server removes the blob,
// broadcasts a refreshed file-list, and rejects illegal deletes
// (main.tex, unknown name). After a server restart, the deleted
// file does not reappear.

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

// --- Run 1: delete refs.bib via the protocol -----------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames } = await bootClient(app, projectId);

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

  const { ws, frames } = await bootClient(app, projectId);

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
