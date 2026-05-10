// Round-trip + edge-case tests for the local-filesystem BlobStore.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsBlobStore, validateKey } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "tex-blobs-"));
const store = new LocalFsBlobStore({ rootDir: root });

try {
  // put/get round-trip with a nested key.
  {
    const body = new Uint8Array([0, 1, 2, 3, 4, 255]);
    await store.put("projects/p1/files/main.tex", body);
    const got = await store.get("projects/p1/files/main.tex");
    assert.ok(got !== null);
    assert.deepEqual(Array.from(got), Array.from(body));
  }

  // get on missing key → null.
  {
    const got = await store.get("projects/p1/missing");
    assert.equal(got, null);
  }

  // overwrite is atomic — no .tmp survivor.
  {
    await store.put("projects/p1/files/main.tex", new Uint8Array([9, 9]));
    const got = await store.get("projects/p1/files/main.tex");
    assert.deepEqual(Array.from(got), [9, 9]);
    const tmpExists = await stat(join(root, "projects/p1/files/main.tex.tmp")).then(
      () => true,
      () => false,
    );
    assert.equal(tmpExists, false);
  }

  // list with directory-shaped prefix.
  {
    await store.put("projects/p1/files/sub/a.tex", new Uint8Array([1]));
    await store.put("projects/p1/files/sub/b.tex", new Uint8Array([2]));
    await store.put("projects/p2/files/main.tex", new Uint8Array([3]));
    const keys = await store.list("projects/p1");
    assert.deepEqual(keys, [
      "projects/p1/files/main.tex",
      "projects/p1/files/sub/a.tex",
      "projects/p1/files/sub/b.tex",
    ]);
  }

  // list with mid-segment prefix.
  {
    const keys = await store.list("projects/p1/files/sub/a");
    assert.deepEqual(keys, ["projects/p1/files/sub/a.tex"]);
  }

  // list of empty store / non-existent prefix → [].
  {
    const keys = await store.list("projects/nope");
    assert.deepEqual(keys, []);
  }

  // delete is idempotent.
  {
    await store.delete("projects/p2/files/main.tex");
    await store.delete("projects/p2/files/main.tex");
    const got = await store.get("projects/p2/files/main.tex");
    assert.equal(got, null);
  }

  // key validation rejects traversal & weirdness.
  {
    const bad = ["", "/abs", "trailing/", "a//b", "a/../b", "a/./b", "a\\b", "a\0b"];
    for (const key of bad) {
      assert.throws(() => validateKey(key), new RegExp("invalid|non-empty"), `expected reject: ${JSON.stringify(key)}`);
      await assert.rejects(store.get(key), /invalid|non-empty/);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("localFs.test.mjs: OK");
