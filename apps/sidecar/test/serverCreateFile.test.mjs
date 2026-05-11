// Sidecar `create-file` control message.
// Verifies: client requests a new file, server adds it to
// knownFiles, PUTs an empty blob, and broadcasts a refreshed
// file-list. After a server restart against the same blob root,
// the file is rehydrated.

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

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-create-file-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "creatable";
// Seed a main.tex so hydration succeeds (and canPersist becomes true).
await blobStore.put(
  `projects/${projectId}/files/main.tex`,
  new TextEncoder().encode("\\documentclass{article}\\begin{document}x\\end{document}"),
);

// --- Run 1: create-file via the protocol ---------------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames } = await bootClient(app, projectId);

  // First file-list arrives with just main.tex.
  await waitFor(
    () =>
      frames.some(
        (f) => f.kind === "control" && f.message.type === "file-list",
      ),
    "initial file-list",
    frames,
  );
  const firstFileList = frames.find(
    (f) => f.kind === "control" && f.message.type === "file-list",
  );
  assert.deepEqual(firstFileList.message.files, [MAIN_DOC_NAME]);

  // Create a new file.
  ws.send(encodeControl({ type: "create-file", name: "chapter1.tex" }));

  // The server broadcasts a refreshed file-list with the new entry.
  await waitFor(
    () =>
      frames.filter(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.includes("chapter1.tex"),
      ).length > 0,
    "post-create file-list",
    frames,
  );
  const fileListWithNew = [...frames]
    .reverse()
    .find((f) => f.kind === "control" && f.message.type === "file-list");
  assert.deepEqual(fileListWithNew.message.files, ["chapter1.tex", "main.tex"]);

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
  const bogusBroadcasts = frames.filter(
    (f) =>
      f.kind === "control" &&
      f.message.type === "file-list" &&
      f.message.files.some((n) => n.includes("..") || n.includes("/")),
  );
  assert.equal(bogusBroadcasts.length, 0, "must not broadcast invalid names");

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold restart sees the new file -------------------------
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
          f.message.files.includes("chapter1.tex"),
      ),
    "chapter1.tex hydrated on restart",
    frames,
  );

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar create-file test: OK");
