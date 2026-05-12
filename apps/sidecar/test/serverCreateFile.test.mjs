// Sidecar `create-file` control message.
// Verifies: client requests a new file, server adds it to
// knownFiles, PUTs an empty blob, and broadcasts a refreshed
// file-list. After a server restart against the same blob root,
// the file is rehydrated.

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
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("create-file");
const projectId = "creatable";
// Seed a main.tex so hydration succeeds (and canPersist becomes true).
await seedMainTex(blobStore, projectId);

// --- Run 1: create-file via the protocol ---------------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames } = await bootClient(app, projectId);

  // First file-list arrives with just main.tex.
  await waitFor(() => frames.some(isFileListFrame), "initial file-list", frames);
  assert.deepEqual(latestFileList(frames).message.files, [MAIN_DOC_NAME]);

  // Create a new file.
  ws.send(encodeControl({ type: "create-file", name: "chapter1.tex" }));

  // The server broadcasts a refreshed file-list with the new entry.
  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("chapter1.tex")),
    "post-create file-list",
    frames,
  );
  assert.deepEqual(latestFileList(frames).message.files, ["chapter1.tex", "main.tex"]);

  // The blob is created with empty content.
  const persisted = await blobStore.get(`projects/${projectId}/files/chapter1.tex`);
  assert.ok(persisted, "expected chapter1.tex blob to exist");
  assert.equal(persisted.length, 0);

  // Invalid name is rejected without crashing: no file-list with it.
  ws.send(encodeControl({ type: "create-file", name: "../escape" }));
  // Duplicate also rejected.
  ws.send(encodeControl({ type: "create-file", name: "chapter1.tex" }));
  // Give the server a beat to process and confirm no extra file-list
  // frame is broadcast naming the bad input.
  await new Promise((r) => setTimeout(r, 100));
  const bogusBroadcasts = fileListFrames(frames).filter((f) =>
    f.message.files.some((n) => n.includes("..") || n.includes("/")),
  );
  assert.equal(bogusBroadcasts.length, 0, "must not broadcast invalid names");

  await closeClient(ws, app);
}

// --- Run 2: cold restart sees the new file -------------------------
{
  const app = await startServer({ blobStore });
  const { ws, frames } = await bootClient(app, projectId);

  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("chapter1.tex")),
    "chapter1.tex hydrated on restart",
    frames,
  );

  await closeClient(ws, app);
}

console.log("sidecar create-file test: OK");
