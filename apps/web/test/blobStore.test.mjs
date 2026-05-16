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
  createSeedDocFor,
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
  // createSeedDocFor: blob wins over db.
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const blobBody = "from-blob";
    await store.put(
      `projects/proj-chain-blob-wins/files/main.tex`,
      new TextEncoder().encode(blobBody),
    );
    let dbCalls = 0;
    const seedDocFor = createSeedDocFor({
      blobStore: store,
      getDbSeedDoc: async () => {
        dbCalls += 1;
        return "from-db";
      },
    });
    const got = await seedDocFor("proj-chain-blob-wins");
    assert.equal(got, blobBody);
    assert.equal(dbCalls, 0, "db must not be consulted when blob exists");
  }
  // createSeedDocFor: no blob → falls through to db.
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const seedDocFor = createSeedDocFor({
      blobStore: store,
      getDbSeedDoc: async (id) => `db-seed-for-${id}`,
    });
    const got = await seedDocFor("proj-chain-db-fallback");
    assert.equal(got, "db-seed-for-proj-chain-db-fallback");
  }
  // createSeedDocFor: empty blob → falls through to db (same shape
  // as "no blob"; coldSourceFor normalises both to null).
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    await store.put(
      `projects/proj-chain-empty/files/main.tex`,
      new Uint8Array(),
    );
    const seedDocFor = createSeedDocFor({
      blobStore: store,
      getDbSeedDoc: async () => "db-wins-after-empty",
    });
    const got = await seedDocFor("proj-chain-empty");
    assert.equal(got, "db-wins-after-empty");
  }
  // createSeedDocFor: no blob + no db row → null (the
  // upstreamResolver omits SEED_MAIN_DOC_B64 in this case).
  {
    const store = new LocalFsBlobStore({ rootDir: root });
    const seedDocFor = createSeedDocFor({
      blobStore: store,
      getDbSeedDoc: async () => null,
    });
    const got = await seedDocFor("proj-chain-no-seed");
    assert.equal(got, null);
  }
  // createSeedDocFor: blob store undefined (deploy opted out of
  // cold storage) → goes straight to db.
  {
    const seedDocFor = createSeedDocFor({
      blobStore: undefined,
      getDbSeedDoc: async (id) => `db-only-${id}`,
    });
    const got = await seedDocFor("proj-no-blobstore");
    assert.equal(got, "db-only-proj-no-blobstore");
  }
  // createSeedDocFor: blob lookup throws → reported and chain
  // falls through to db. A transient blob-store outage must not
  // pin a project to its db seed forever.
  {
    const throwingStore = {
      get: async () => {
        throw new Error("simulated transport error");
      },
      put: async () => {},
      delete: async () => {},
    };
    const errors = [];
    const seedDocFor = createSeedDocFor({
      blobStore: throwingStore,
      getDbSeedDoc: async () => "db-after-blob-error",
      onBlobError: (e) => errors.push(e),
    });
    const got = await seedDocFor("proj-blob-error");
    assert.equal(got, "db-after-blob-error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].projectId, "proj-blob-error");
    assert.match(errors[0].message, /simulated transport error/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("apps/web/test/blobStore.test.mjs: OK");
