// Unit test for the M7.4 checkpoint blob protocol on the
// `Compiler` interface, and the persistence-helper round-trip.
//
// At this stage every concrete compiler implements `snapshot` as
// a no-op returning `null` and `restore` as an accept-and-discard
// no-op — upstream supertex doesn't yet expose a serialise wire
// (PLAN.md "Candidate supertex (upstream) work" item 2). This
// test pins that contract so a future iteration that adds real
// serialisation to `SupertexDaemonCompiler` (or replaces the
// no-op) is forced to update tests deliberately, not silently.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { FixtureCompiler } from "../src/compiler/fixture.ts";
import { SupertexOnceCompiler } from "../src/compiler/supertexOnce.ts";
import { SupertexDaemonCompiler } from "../src/compiler/supertexDaemon.ts";
import {
  loadCheckpoint,
  persistCheckpoint,
  projectCheckpointKey,
} from "../src/persistence.ts";

// 1. Compiler.snapshot returns null and restore is a no-op for
//    every implementation today. Constructing each compiler with
//    enough config that it doesn't throw before snapshot/restore;
//    no compile() is run, so no executable is required.
{
  const fixture = new FixtureCompiler("/nonexistent/fixture.pdf");
  assert.equal(await fixture.snapshot(), null);
  await fixture.restore(new Uint8Array([1, 2, 3]));
  assert.equal(await fixture.snapshot(), null);
  await fixture.close();
}
{
  const once = new SupertexOnceCompiler({
    workDir: "/tmp/no-such-dir",
    supertexBin: "/bin/false",
  });
  assert.equal(await once.snapshot(), null);
  await once.restore(new Uint8Array(0));
  await once.close();
}
{
  // SupertexDaemonCompiler with a binary that won't be spawned —
  // snapshot/restore must not spawn the child.
  const daemon = new SupertexDaemonCompiler({
    workDir: "/tmp/no-such-dir",
    supertexBin: "/bin/false",
  });
  assert.equal(await daemon.snapshot(), null);
  await daemon.restore(new Uint8Array([9, 9, 9]));
  await daemon.close();
}

// 2. projectCheckpointKey is stable, project-scoped, and lives
//    outside `files/` (so file listings never surface it).
{
  const k = projectCheckpointKey("proj-alpha");
  assert.equal(k, "projects/proj-alpha/checkpoint.bin");
  assert.ok(!k.includes("/files/"));
}

// 3. persistCheckpoint + loadCheckpoint round-trip the bytes
//    verbatim, with the null/empty no-op semantics.
{
  const root = mkdtempSync(join(tmpdir(), "checkpoint-blob-"));
  const store = new LocalFsBlobStore({ rootDir: root });

  // No checkpoint stored yet → load returns null.
  assert.equal(await loadCheckpoint(store, "p1"), null);

  // persistCheckpoint(null) is a no-op.
  await persistCheckpoint(store, "p1", null);
  assert.equal(await loadCheckpoint(store, "p1"), null);

  // Empty bytes are treated as "no checkpoint" (defensive).
  await persistCheckpoint(store, "p1", new Uint8Array(0));
  assert.equal(await loadCheckpoint(store, "p1"), null);

  // Real bytes round-trip exactly.
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  await persistCheckpoint(store, "p1", bytes);
  const got = await loadCheckpoint(store, "p1");
  assert.ok(got instanceof Uint8Array);
  assert.deepEqual(Array.from(got), Array.from(bytes));

  // Different projects are isolated.
  assert.equal(await loadCheckpoint(store, "p2"), null);
}

console.log("checkpointBlob test: OK");
