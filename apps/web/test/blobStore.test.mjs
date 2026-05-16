// Unit tests for the web-tier cold-storage primitive (M20.2(a)).
//
// Covers the env selector contract (none/local/s3/unknown) and the
// `coldSourceFor` lookup against a `LocalFsBlobStore` populated at
// the canonical `projects/<id>/files/main.tex` key shape — the
// shape the sidecar persists at.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import {
  coldSourceFor,
  webBlobStoreFromEnv,
} from "../src/lib/server/blobStore.ts";

const root = await mkdtemp(join(tmpdir(), "tex-web-blobs-"));

try {
  // env: unset → undefined.
  {
    const got = webBlobStoreFromEnv({});
    assert.equal(got, undefined);
  }
  // env: "none" → undefined.
  {
    const got = webBlobStoreFromEnv({ BLOB_STORE: "none" });
    assert.equal(got, undefined);
  }
  // env: "local" without dir → throws clearly.
  {
    assert.throws(
      () => webBlobStoreFromEnv({ BLOB_STORE: "local" }),
      /BLOB_STORE_LOCAL_DIR/,
    );
  }
  // env: "local" with dir → a usable BlobStore round-tripping a blob.
  {
    const store = webBlobStoreFromEnv({
      BLOB_STORE: "local",
      BLOB_STORE_LOCAL_DIR: root,
    });
    assert.ok(store !== undefined);
    await store.put("smoke", new Uint8Array([1, 2, 3]));
    const got = await store.get("smoke");
    assert.ok(got !== null);
    assert.deepEqual(Array.from(got), [1, 2, 3]);
    await store.delete("smoke");
  }
  // env: "s3" → rejected (M20.2 cutover gate).
  {
    assert.throws(
      () => webBlobStoreFromEnv({ BLOB_STORE: "s3" }),
      /s3 not implemented/,
    );
  }
  // env: unknown → rejected.
  {
    assert.throws(
      () => webBlobStoreFromEnv({ BLOB_STORE: "ftp" }),
      /unknown BLOB_STORE/,
    );
  }

  // coldSourceFor: no blob → null.
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const got = await coldSourceFor(store, "proj-empty");
    assert.equal(got, null);
  }
  // coldSourceFor: empty blob → null (treated as no persisted source).
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    await store.put("projects/proj-empty-blob/files/main.tex", new Uint8Array());
    const got = await coldSourceFor(store, "proj-empty-blob");
    assert.equal(got, null);
  }
  // coldSourceFor: populated blob → UTF-8 decoded contents.
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const body = "\\documentclass{article}\n\\begin{document}\nHello, cold storage.\n\\end{document}\n";
    await store.put(
      "projects/proj-1/files/main.tex",
      new TextEncoder().encode(body),
    );
    const got = await coldSourceFor(store, "proj-1");
    assert.equal(got, body);
  }
  // coldSourceFor: key shape matches the sidecar's `mainTexKey`. The
  // sidecar persists at `projects/<id>/files/main.tex`; if a future
  // refactor moves the key, this assertion catches the drift.
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const body = "drift-canary";
    // Stash bytes at the *exact* sidecar key shape, then read via
    // the web tier's `coldSourceFor` — they must agree on the path.
    await store.put(
      `projects/proj-drift/files/main.tex`,
      new TextEncoder().encode(body),
    );
    const got = await coldSourceFor(store, "proj-drift");
    assert.equal(got, body);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("apps/web/test/blobStore.test.mjs: OK");
