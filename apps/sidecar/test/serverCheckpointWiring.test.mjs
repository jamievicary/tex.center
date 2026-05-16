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
  constructor(snapshotBytes, { supportsCheckpoint = true } = {}) {
    this.supportsCheckpoint = supportsCheckpoint;
    this.restoreCalls = [];
    this.compileCalls = 0;
    this.snapshotBytes = snapshotBytes;
    this.snapshotCalls = 0;
    this.warmupCalls = 0;
  }
  async compile() {
    this.compileCalls += 1;
    return { ok: true, segments: [] };
  }
  async close() {}
  async warmup() {
    this.warmupCalls += 1;
  }
  async snapshot() {
    this.snapshotCalls += 1;
    return this.snapshotBytes;
  }
  async restore(blob) {
    this.restoreCalls.push(Array.from(blob));
  }
}

// Wraps a `LocalFsBlobStore` and counts `get(projectCheckpointKey)`
// reads so case 4 can assert the cold-boot path skips the Tigris
// GET entirely when `supportsCheckpoint = false`.
class GetCountingBlobStore {
  constructor(inner) {
    this.inner = inner;
    this.getCalls = [];
  }
  get(key) {
    this.getCalls.push(key);
    return this.inner.get(key);
  }
  put(key, bytes) {
    return this.inner.put(key, bytes);
  }
  delete(key) {
    return this.inner.delete(key);
  }
  list(prefix) {
    return this.inner.list(prefix);
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
  let onSuspendObservedSnapshotBytes = null;
  let idleResolve;
  const idleDone = new Promise((r) => {
    idleResolve = r;
  });

  const app = await buildServer({
    logger: false,
    scratchRoot,
    blobStore,
    compilerFactory: () => compiler,
    suspendTimeoutMs: 40,
    onSuspend: () => {
      // Inspect the blob the wrapper persisted before handing off.
      void loadCheckpoint(blobStore, "p1").then((bytes) => {
        onSuspendObservedSnapshotBytes = bytes ? Array.from(bytes) : null;
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
    onSuspendObservedSnapshotBytes,
    Array.from(snapshotBytes),
    "blob at checkpoint key should hold the snapshot bytes BEFORE onSuspend is invoked",
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
    suspendTimeoutMs: 30,
    onSuspend: () => idleResolve(),
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

// Case 4 (M20.3(a)2): when the compiler reports
// `supportsCheckpoint = false`, the sidecar must skip the cold-boot
// `loadCheckpoint` GET entirely (no read of the checkpoint key) AND
// must NOT call snapshot/restore on the compiler, even if a
// checkpoint blob is already present at the project's key. The
// idle-stop persist path is symmetric: snapshot is not consulted.
{
  const blobRoot = mkdtempSync(join(tmpdir(), "checkpoint-wiring-nosupport-"));
  const scratchRoot = mkdtempSync(
    join(tmpdir(), "checkpoint-wiring-nosupport-scratch-"),
  );
  const inner = new LocalFsBlobStore({ rootDir: blobRoot });
  const blobStore = new GetCountingBlobStore(inner);

  // Pre-seed a checkpoint blob at the project's checkpoint key. A
  // checkpoint-supporting compiler (case 1) would consume this on
  // cold boot; a non-supporting compiler must ignore it.
  const seed = new Uint8Array([7, 7, 7, 7]);
  await persistCheckpoint(blobStore, "p4", seed);
  const checkpointKey = "projects/p4/checkpoint.bin";
  // Drop the `put` made by persistCheckpoint so we measure only
  // get-traffic during the cold boot.
  blobStore.getCalls.length = 0;

  const compiler = new RecordingCompiler(new Uint8Array([1, 2]), {
    supportsCheckpoint: false,
  });
  let idleResolve;
  const idleDone = new Promise((r) => {
    idleResolve = r;
  });

  const app = await buildServer({
    logger: false,
    scratchRoot,
    blobStore,
    compilerFactory: () => compiler,
    suspendTimeoutMs: 30,
    onSuspend: () => idleResolve(),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const ws = await open(`ws://127.0.0.1:${port}/ws/project/p4`);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && compiler.compileCalls === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(compiler.compileCalls > 0, true, "compile must have run");
  assert.deepEqual(
    compiler.restoreCalls,
    [],
    "supportsCheckpoint=false: restore must NOT be called even with a seeded blob",
  );
  assert.equal(
    blobStore.getCalls.includes(checkpointKey),
    false,
    `supportsCheckpoint=false: blobStore.get must not be called with ${checkpointKey}; ` +
      `observed gets: ${JSON.stringify(blobStore.getCalls)}`,
  );

  await closeAndWait(ws);
  await idleDone;

  assert.equal(
    compiler.snapshotCalls,
    0,
    "supportsCheckpoint=false: snapshot must NOT be called on idle-stop",
  );
  // And the pre-seeded blob is untouched (proof we did not
  // overwrite or delete it during the idle cycle).
  const stillThere = await loadCheckpoint(blobStore, "p4");
  assert.deepEqual(
    stillThere ? Array.from(stillThere) : null,
    Array.from(seed),
    "supportsCheckpoint=false: pre-seeded blob must remain intact",
  );

  await app.close();
}

console.log("sidecar checkpoint wiring test: OK");
