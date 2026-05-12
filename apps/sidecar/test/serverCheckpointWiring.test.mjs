// M7.4.1 wiring: buildServer drives `Compiler.restore` on cold start
// (when a checkpoint blob is present) and `Compiler.snapshot` on
// idle-stop, persisting the blob to the project's key. Real
// compilers all return null from snapshot today, so end-to-end
// behaviour is unobservable in prod; this test pins the plumbing
// with a recording compiler so the day upstream lands a serialise
// wire, the sidecar half needs no further work.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { buildServer } from "../src/server.ts";
import {
  loadCheckpoint,
  persistCheckpoint,
} from "../src/persistence.ts";

class RecordingCompiler {
  constructor(snapshotBytes) {
    this.restoreCalls = [];
    this.compileCalls = 0;
    this.snapshotBytes = snapshotBytes;
    this.snapshotCalls = 0;
  }
  async compile() {
    this.compileCalls += 1;
    return { ok: true, segments: [] };
  }
  async close() {}
  async snapshot() {
    this.snapshotCalls += 1;
    return this.snapshotBytes;
  }
  async restore(blob) {
    this.restoreCalls.push(Array.from(blob));
  }
}

async function open(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  return ws;
}

async function closeAndWait(ws) {
  ws.close();
  await new Promise((r) => ws.once("close", r));
}

// Case 1: pre-seeded checkpoint → restore is called with those bytes
// before any compile(); idle-stop snapshots the compiler and persists
// the bytes back to the same key, in that order, before invoking the
// user's onIdle.
{
  const blobRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-scratch-"));
  const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

  // Seed a checkpoint at projects/p1/checkpoint.bin.
  const seed = new Uint8Array([1, 2, 3, 4]);
  await persistCheckpoint(blobStore, "p1", seed);

  const snapshotBytes = new Uint8Array([9, 9, 9, 9, 9]);
  const compiler = new RecordingCompiler(snapshotBytes);
  let onIdleObservedSnapshotBytes = null;
  let idleResolve;
  const idleDone = new Promise((r) => {
    idleResolve = r;
  });

  const app = await buildServer({
    logger: false,
    scratchRoot,
    blobStore,
    compilerFactory: () => compiler,
    idleTimeoutMs: 40,
    onIdle: () => {
      // Inspect the blob the wrapper persisted before handing off.
      void loadCheckpoint(blobStore, "p1").then((bytes) => {
        onIdleObservedSnapshotBytes = bytes ? Array.from(bytes) : null;
        idleResolve();
      });
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p1`);

  // Wait for the first compile to have run — that's where restore
  // is wired in.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && compiler.compileCalls === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(compiler.compileCalls > 0, true, "compile must have run");
  assert.deepEqual(
    compiler.restoreCalls,
    [Array.from(seed)],
    "restore should be called exactly once with the seeded bytes",
  );

  await closeAndWait(ws);

  // Idle timer fires after 40ms; allow margin.
  await idleDone;

  assert.equal(compiler.snapshotCalls, 1, "snapshot should be called once on idle");
  assert.deepEqual(
    onIdleObservedSnapshotBytes,
    Array.from(snapshotBytes),
    "blob at checkpoint key should hold the snapshot bytes BEFORE onIdle is invoked",
  );

  await app.close();
}

// Case 2: no checkpoint pre-seeded → restore is NOT called. (A
// missing checkpoint is the cold-cold-start state and must not feed
// an empty blob through `restore()`.)
{
  const blobRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-empty-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-empty-scratch-"));
  const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

  const compiler = new RecordingCompiler(null);

  const app = await buildServer({
    logger: false,
    scratchRoot,
    blobStore,
    compilerFactory: () => compiler,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p2`);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && compiler.compileCalls === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(compiler.compileCalls > 0, true, "compile must have run");
  assert.deepEqual(compiler.restoreCalls, [], "restore should NOT be called when no checkpoint exists");

  await closeAndWait(ws);
  await app.close();
}

// Case 3: snapshot returning null is a no-op — no blob is written.
{
  const blobRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-null-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-null-scratch-"));
  const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

  const compiler = new RecordingCompiler(null);
  let idleResolve;
  const idleDone = new Promise((r) => {
    idleResolve = r;
  });

  const app = await buildServer({
    logger: false,
    scratchRoot,
    blobStore,
    compilerFactory: () => compiler,
    idleTimeoutMs: 30,
    onIdle: () => idleResolve(),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p3`);
  await closeAndWait(ws);
  await idleDone;

  assert.equal(compiler.snapshotCalls, 1, "snapshot is still consulted");
  assert.equal(
    await loadCheckpoint(blobStore, "p3"),
    null,
    "no blob should be written when snapshot returns null",
  );

  await app.close();
}

console.log("sidecar checkpoint wiring test: OK");
