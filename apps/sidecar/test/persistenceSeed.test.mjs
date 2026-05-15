// Lock the canonical 4-line hello-world template seeded into a
// fresh project's main.tex. The exact bytes are part of the UX
// contract (iter 167) — a future "trim trailing newline" or
// "switch to amsart" edit must surface as a test failure rather
// than drift silently into production.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import {
  MAIN_DOC_HELLO_WORLD,
  MAIN_DOC_NAME,
} from "../../../packages/protocol/src/index.ts";
import {
  createProjectPersistence,
  mainTexKey,
} from "../src/persistence.ts";

const EXPECTED =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Hello, world!\n" +
  "\\end{document}\n";

// 1. The constant itself is exactly the canonical 4-line template.
assert.equal(MAIN_DOC_HELLO_WORLD, EXPECTED);
assert.equal(EXPECTED.split("\n").filter((l) => l.length > 0).length, 4);

const log = {
  warn: (detail, msg) => {
    throw new Error(
      `unexpected log.warn: ${msg} ${JSON.stringify(detail)}`,
    );
  },
};

// 2. In-memory mode (no blob store) — Y.Text seeds on construction.
{
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: undefined,
    projectId: "p-mem",
    doc,
    log,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), EXPECTED);
}

// 3. Blob-store mode, brand-new project — Y.Text is seeded AND the
//    blob is persisted with the same bytes.
{
  const root = mkdtempSync(join(tmpdir(), "persistence-seed-new-"));
  const store = new LocalFsBlobStore({ rootDir: root });
  const doc = new Y.Doc();
  const projectId = "p-new";
  const p = createProjectPersistence({
    blobStore: store,
    projectId,
    doc,
    log,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), EXPECTED);
  const blob = await store.get(mainTexKey(projectId));
  assert.ok(blob !== null, "main.tex blob should be written on seed");
  assert.equal(new TextDecoder().decode(blob), EXPECTED);
}

// 4. Blob-store mode, existing project — seed does NOT clobber.
{
  const root = mkdtempSync(join(tmpdir(), "persistence-seed-existing-"));
  const store = new LocalFsBlobStore({ rootDir: root });
  const projectId = "p-old";
  const existing = "% user content\n";
  await store.put(mainTexKey(projectId), new TextEncoder().encode(existing));
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: store,
    projectId,
    doc,
    log,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), existing);
  const blob = await store.get(mainTexKey(projectId));
  assert.equal(new TextDecoder().decode(blob), existing);
}

// 5. Blob-store mode, existing-but-empty main.tex — also NOT
//    clobbered. An empty blob is a legitimate user state ("I
//    deleted everything"); re-seeding would lose that intent.
{
  const root = mkdtempSync(join(tmpdir(), "persistence-seed-empty-"));
  const store = new LocalFsBlobStore({ rootDir: root });
  const projectId = "p-empty";
  await store.put(mainTexKey(projectId), new Uint8Array(0));
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: store,
    projectId,
    doc,
    log,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), "");
  const blob = await store.get(mainTexKey(projectId));
  assert.equal(blob.length, 0);
}

// 6. seedMainDoc override (M15 Step D) — in-memory mode picks up
//    the override instead of MAIN_DOC_HELLO_WORLD.
{
  const TWO_PAGE =
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    "Page one body text.\n" +
    "\\newpage\n" +
    "Page two body text.\n" +
    "\\end{document}\n";
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: undefined,
    projectId: "p-seeded-mem",
    doc,
    log,
    seedMainDoc: TWO_PAGE,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), TWO_PAGE);
}

// 7. seedMainDoc override, blob-store mode, fresh project — Y.Text
//    seeds with the override AND the persisted blob carries the
//    override bytes.
{
  const TWO_PAGE =
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    "Page one body text.\n" +
    "\\newpage\n" +
    "Page two body text.\n" +
    "\\end{document}\n";
  const root = mkdtempSync(join(tmpdir(), "persistence-seed-override-"));
  const store = new LocalFsBlobStore({ rootDir: root });
  const projectId = "p-seeded-new";
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: store,
    projectId,
    doc,
    log,
    seedMainDoc: TWO_PAGE,
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), TWO_PAGE);
  const blob = await store.get(mainTexKey(projectId));
  assert.ok(blob !== null, "main.tex blob should be written with override");
  assert.equal(new TextDecoder().decode(blob), TWO_PAGE);
}

// 8. seedMainDoc override, blob-store mode, EXISTING main.tex —
//    the override does NOT clobber persisted user content. The
//    seed is a first-hydration default only.
{
  const root = mkdtempSync(join(tmpdir(), "persistence-seed-override-existing-"));
  const store = new LocalFsBlobStore({ rootDir: root });
  const projectId = "p-seeded-existing";
  const existing = "% user content survives override\n";
  await store.put(mainTexKey(projectId), new TextEncoder().encode(existing));
  const doc = new Y.Doc();
  const p = createProjectPersistence({
    blobStore: store,
    projectId,
    doc,
    log,
    seedMainDoc:
      "\\documentclass{article}\n" +
      "\\begin{document}\nIgnored\n\\end{document}\n",
  });
  await p.awaitHydrated();
  assert.equal(doc.getText(MAIN_DOC_NAME).toString(), existing);
}

console.log("persistenceSeed test: OK");
