// Sidecar wiring of `BlobStore` (M4.3.2). Boots a server with a
// `LocalFsBlobStore`, verifies:
//   1. A pre-populated `projects/<id>/files/main.tex` is hydrated
//      into the project's Y.Text and shipped to the first client.
//   2. An edit driven through Yjs is persisted back to the same
//      blob key after the next compile.
//   3. After server restart against the same blob root, the new
//      content is still there.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { MAIN_DOC_NAME, decodeFrame, encodeDocUpdate } from "../../../packages/protocol/src/index.ts";
import { buildServer } from "../src/server.ts";
import { bootClient, waitFor } from "./lib.mjs";

const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-blob-test-"));
const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

const projectId = "alpha";
const initial = "\\documentclass{article}\\begin{document}hello\\end{document}";
const refsBibContents = "@book{x,...}";
await blobStore.put(`projects/${projectId}/files/main.tex`, new TextEncoder().encode(initial));
// Sibling file to exercise multi-file `file-list` + hydration.
await blobStore.put(`projects/${projectId}/files/refs.bib`, new TextEncoder().encode(refsBibContents));

// --- Run 1: hydrate, edit, persist ---------------------------------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc, text } = await bootClient(app, projectId);
  await waitFor(() => text.toString() === initial, "hydrated initial", frames);

  // Multi-file hydration: refs.bib must be present on the same
  // Y.Doc, keyed by its relative path. The single doc-level update
  // carries every Y.Text, so the client sees both files in one
  // frame.
  await waitFor(
    () => clientDoc.getText("refs.bib").toString() === refsBibContents,
    "refs.bib hydrated",
    frames,
  );

  // The blob store has `main.tex` plus a sibling `refs.bib`; the
  // file-list control message must reflect both, sorted.
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "file-list" &&
          f.message.files.length === 2,
      ),
    "file-list with two files",
    frames,
  );
  const fileListFrame = frames.find(
    (f) => f.kind === "control" && f.message.type === "file-list",
  );
  assert.deepEqual(fileListFrame.message.files, ["main.tex", "refs.bib"]);

  // Drive an edit through the same Yjs doc the test client holds —
  // produce a delta against current state and ship it. The server
  // applies but doesn't echo back to the originator, so we only
  // assert against the blob.
  const target = `${initial}\n% extra line`;
  const refsBibTarget = `${refsBibContents}\n@article{y,...}`;
  const refsBibText = clientDoc.getText("refs.bib");
  const before = Y.encodeStateVector(text.doc);
  text.doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, target);
    refsBibText.delete(0, refsBibText.length);
    refsBibText.insert(0, refsBibTarget);
  });
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(text.doc, before)));

  await waitFor(async () => {
    const persisted = await blobStore.get(`projects/${projectId}/files/main.tex`);
    return persisted && new TextDecoder().decode(persisted) === target;
  }, "main.tex blob updated", frames);
  // Multi-file persistence: the sibling file's blob is also pushed
  // on the same compile.
  await waitFor(async () => {
    const persisted = await blobStore.get(`projects/${projectId}/files/refs.bib`);
    return persisted && new TextDecoder().decode(persisted) === refsBibTarget;
  }, "refs.bib blob updated", frames);

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 1b: failing compile still persists source -----------------
// Persistence must not be gated on compile success; otherwise an
// edit that triggers a TeX error would silently vanish on restart.
{
  const failingCompilerFactory = () => ({
    async compile() {
      return { ok: false, error: "boom" };
    },
    async close() {},
  });
  const app = await buildServer({
    logger: false,
    blobStore,
    compilerFactory: failingCompilerFactory,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, text } = await bootClient(app, projectId);
  const startBlob = await blobStore.get(`projects/${projectId}/files/main.tex`);
  const startText = new TextDecoder().decode(startBlob);
  await waitFor(() => text.toString() === startText, "hydrated for failing-compile run", frames);

  const target = `${startText}\n% even though compile fails`;
  const before = Y.encodeStateVector(text.doc);
  text.doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, target);
  });
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(text.doc, before)));

  await waitFor(async () => {
    const persisted = await blobStore.get(`projects/${projectId}/files/main.tex`);
    return persisted && new TextDecoder().decode(persisted) === target;
  }, "blob updated despite failing compile", frames);

  // Sanity: the server did broadcast a compile-status:error frame,
  // confirming the failing-compiler path actually ran.
  const errored = frames.some(
    (f) => f.kind === "control" && f.message.type === "compile-status" && f.message.state === "error",
  );
  assert.equal(errored, true, "expected compile-status:error from failing compiler");

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 1c: failed hydration must NOT clobber the remote blob ----
// If `blobStore.get` throws (transient outage, partial failure),
// the project state's `persistedSource` would historically remain
// null. The next compile would then evaluate `source !==
// persistedSource` as trivially true and overwrite the legitimate
// blob with the empty in-memory Y.Text — silent data loss.
{
  const sentinel = "PRESERVE_ME_DO_NOT_CLOBBER";
  const isolatedRoot = mkdtempSync(join(tmpdir(), "sidecar-blob-fail-test-"));
  const realStore = new LocalFsBlobStore({ rootDir: isolatedRoot });
  const sentinelKey = `projects/beta/files/main.tex`;
  await realStore.put(sentinelKey, new TextEncoder().encode(sentinel));

  // One-shot get-failing wrapper; subsequent calls pass through.
  let getCallsBeforeFail = 1;
  const flakyStore = {
    async get(key) {
      if (getCallsBeforeFail-- > 0) throw new Error("simulated transient blob outage");
      return realStore.get(key);
    },
    put: realStore.put.bind(realStore),
    list: realStore.list.bind(realStore),
    delete: realStore.delete.bind(realStore),
    health: realStore.health.bind(realStore),
  };

  const app = await buildServer({ logger: false, blobStore: flakyStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  // Override projectId for this run via direct WS — bootClient uses
  // the module-level `projectId`, so spin a minimal client inline.
  const address = app.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/project/beta`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const clientDoc = new Y.Doc();
  const text = clientDoc.getText(MAIN_DOC_NAME);
  ws.on("message", (data) => {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const f = decodeFrame(buf);
    frames.push(f);
    if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  // Drive a destructive edit. If the bug is unfixed, the server
  // will clobber the sentinel blob with this content.
  const target = "this would destroy the original";
  const before = Y.encodeStateVector(text.doc);
  text.doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, target);
  });
  ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(text.doc, before)));

  // Wait for the compile to fire and the (would-be) put to settle.
  // We can't observe a "no-op put" directly, so wait for an idle
  // compile-status frame, which the server sends after the compile
  // path completes.
  await waitFor(
    () => frames.some((f) => f.kind === "control" && f.message.type === "compile-status" && f.message.state === "idle"),
    "compile completed",
    frames,
  );

  // Assert the blob is untouched.
  const persisted = await realStore.get(sentinelKey);
  const persistedText = new TextDecoder().decode(persisted);
  assert.equal(persistedText, sentinel, "failed hydration must not overwrite the remote blob");

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

// --- Run 2: cold-start hydration sees the persisted edit -----------
{
  const app = await buildServer({ logger: false, blobStore });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { ws, frames, clientDoc, text } = await bootClient(app, projectId);
  const expected = `${initial}\n% extra line\n% even though compile fails`;
  await waitFor(() => text.toString() === expected, "rehydrated edit", frames);
  const expectedRefsBib = `${refsBibContents}\n@article{y,...}`;
  await waitFor(
    () => clientDoc.getText("refs.bib").toString() === expectedRefsBib,
    "rehydrated refs.bib edit",
    frames,
  );

  ws.close();
  await new Promise((r) => ws.once("close", r));
  await app.close();
}

console.log("sidecar blob wiring test: OK");
