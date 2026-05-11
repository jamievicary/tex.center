// Unit test for `listProjectFiles` — the multi-file foundation
// primitive. Hydration of the in-memory Y.Doc remains main.tex-only;
// this exercises just the listing seam against a real
// `LocalFsBlobStore`.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsBlobStore } from "../../../packages/blobs/src/index.ts";
import { listProjectFiles, mainTexKey } from "../src/persistence.ts";

const root = mkdtempSync(join(tmpdir(), "list-project-files-"));
const store = new LocalFsBlobStore({ rootDir: root });

// Empty project → empty list.
assert.deepEqual(await listProjectFiles(store, "empty"), []);

// Multi-file project, including a nested path. `main.tex` plus a
// sibling and a nested `.bib`.
const projectId = "alpha";
await store.put(mainTexKey(projectId), new TextEncoder().encode("\\documentclass{article}"));
await store.put(`projects/${projectId}/files/refs.bib`, new TextEncoder().encode("@book{x,...}"));
await store.put(`projects/${projectId}/files/figures/diagram.tex`, new TextEncoder().encode("% fig"));

// A sibling key that merely starts with "files" — must NOT be
// returned. (`projects/<id>/files-meta` is the canonical foot-gun
// for a startsWith-only filter.)
await store.put(`projects/${projectId}/files-meta`, new TextEncoder().encode("ignore me"));

const got = await listProjectFiles(store, projectId);
assert.deepEqual(got, ["figures/diagram.tex", "main.tex", "refs.bib"]);

// Different project IDs are isolated.
assert.deepEqual(await listProjectFiles(store, "beta"), []);

console.log("listProjectFiles test: OK");
