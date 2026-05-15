// M11.1b smoke: addFile / renameFile / deleteFile / maybePersist
// against a real `LocalFsBlobStore` with `/`-separated paths. The
// protocol validator now accepts multi-segment names; this pin
// confirms they round-trip end-to-end (validate → blob put with
// `mkdir -p` → list survives a fresh hydration → rename moves both
// in-Y.Doc text and blob key → delete reaps the empty virtual
// folder).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import {
  createProjectPersistence,
  listProjectFiles,
} from "../src/persistence.ts";

const root = mkdtempSync(join(tmpdir(), "slashed-names-"));
const store = new LocalFsBlobStore({ rootDir: root });

const captured = [];
const log = { warn: (detail, msg) => captured.push({ detail, msg }) };

const projectId = "p1";

// 1. addFile with a multi-segment path PUTs through `mkdir -p`.
const doc1 = new Y.Doc();
const p1 = createProjectPersistence({ blobStore: store, projectId, doc: doc1, log });
await p1.awaitHydrated();

const r1 = await p1.addFile("chapters/intro.tex", "% chapter one\n");
assert.deepEqual(r1, { ok: true });

const r2 = await p1.addFile("chapters/sub/deep.tex", "deep\n");
assert.deepEqual(r2, { ok: true });

// In-memory file list includes both, sorted.
assert.deepEqual(p1.files(), [
  "chapters/intro.tex",
  "chapters/sub/deep.tex",
  "main.tex",
]);

// On-disk: the blobs are under the expected nested directories.
await stat(join(root, "projects", projectId, "files", "chapters", "intro.tex"));
await stat(
  join(root, "projects", projectId, "files", "chapters", "sub", "deep.tex"),
);

// 2. `listProjectFiles` surfaces the slashed paths (used by
//    `file-list` control + future fresh hydration).
const listed = await listProjectFiles(store, projectId);
assert.deepEqual(listed.sort(), [
  "chapters/intro.tex",
  "chapters/sub/deep.tex",
  "main.tex",
]);

// 3. A fresh persistence instance (simulates Machine cold start)
//    rehydrates the slashed entries into their own Y.Texts.
const doc2 = new Y.Doc();
const p2 = createProjectPersistence({ blobStore: store, projectId, doc: doc2, log });
await p2.awaitHydrated();
assert.deepEqual(p2.files(), [
  "chapters/intro.tex",
  "chapters/sub/deep.tex",
  "main.tex",
]);
assert.equal(doc2.getText("chapters/intro.tex").toString(), "% chapter one\n");
assert.equal(doc2.getText("chapters/sub/deep.tex").toString(), "deep\n");

// 4. Rename across folder boundaries.
const r3 = await p2.renameFile("chapters/intro.tex", "intro.tex");
assert.deepEqual(r3, { ok: true });
assert.deepEqual(p2.files(), [
  "chapters/sub/deep.tex",
  "intro.tex",
  "main.tex",
]);
// Old blob is gone, new blob carries the contents.
assert.equal(await store.get(`projects/${projectId}/files/chapters/intro.tex`), null);
const moved = await store.get(`projects/${projectId}/files/intro.tex`);
assert.ok(moved !== null);
assert.equal(new TextDecoder().decode(moved), "% chapter one\n");

// 5. Delete the deepest leaf — `chapters/sub/` and `chapters/`
//    both reap (R2/the parent-reap path in LocalFsBlobStore).
const r4 = await p2.deleteFile("chapters/sub/deep.tex");
assert.deepEqual(r4, { ok: true });
const subExists = await stat(
  join(root, "projects", projectId, "files", "chapters", "sub"),
).then(() => true, () => false);
const chaptersExists = await stat(
  join(root, "projects", projectId, "files", "chapters"),
).then(() => true, () => false);
assert.equal(subExists, false);
assert.equal(chaptersExists, false);
// But `projects/<id>/files/` still exists because `main.tex` lives
// there.
await stat(join(root, "projects", projectId, "files", "main.tex"));

// 6. Validation rejects bad multi-segment shapes.
const r5 = await p2.addFile("../evil", "boom");
assert.equal(r5.ok, false);
const r6 = await p2.addFile("a/", "boom");
assert.equal(r6.ok, false);
const r7 = await p2.addFile("a//b", "boom");
assert.equal(r7.ok, false);

// No warn() noise from happy-path operations.
assert.deepEqual(captured, [], `unexpected warnings: ${JSON.stringify(captured)}`);

console.log("slashedFileNames.test.mjs: OK");
