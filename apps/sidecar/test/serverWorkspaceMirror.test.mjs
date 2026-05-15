// M23.2 — lock the workspace-mirror behaviour end-to-end.
// Every successful file mutation reaches the on-disk workspace:
//   - `create-file` → empty file at `<scratchRoot>/<projectId>/<name>`
//   - `upload-file` → file populated with the uploaded bytes
//   - `delete-file` → file is removed
//   - `rename-file` → old path gone, new path holds the contents
// Plus: cold restart with a pre-seeded non-main blob — the file
// reaches disk inside the hydration block so the supertex daemon's
// `cwd: workDir` can resolve `\input{sec1}` on the first compile.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAIN_DOC_NAME,
  encodeControl,
} from "../../../packages/protocol/src/index.ts";
import {
  bootClient,
  closeClient,
  fileListFrames,
  isFileListFrame,
  latestFileList,
  makeBlobStore,
  seedFile,
  seedMainTex,
  startServer,
  waitFor,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("workspace-mirror");
const projectId = "mirror-proj";
await seedMainTex(blobStore, projectId);

// --- Run 1: every file op mirrors to disk -------------------------
{
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-mirror-scratch-"));
  const projectDir = join(scratchRoot, projectId);
  const app = await startServer({ blobStore, scratchRoot });
  const { ws, frames } = await bootClient(app, projectId);

  await waitFor(() => frames.some(isFileListFrame), "initial file-list", frames);

  // create-file → empty file on disk.
  ws.send(encodeControl({ type: "create-file", name: "sec1.tex" }));
  await waitFor(
    () => fileListFrames(frames).some((f) => f.message.files.includes("sec1.tex")),
    "sec1.tex in file-list",
    frames,
  );
  await waitFor(
    () => existsSync(join(projectDir, "sec1.tex")),
    "sec1.tex mirrored to disk",
    frames,
  );
  assert.equal(readFileSync(join(projectDir, "sec1.tex"), "utf8"), "");

  // upload-file → file with uploaded bytes on disk.
  const REFS = "@book{a,title={t}}\n";
  ws.send(encodeControl({ type: "upload-file", name: "refs.bib", content: REFS }));
  await waitFor(
    () => existsSync(join(projectDir, "refs.bib")),
    "refs.bib mirrored to disk",
    frames,
  );
  assert.equal(readFileSync(join(projectDir, "refs.bib"), "utf8"), REFS);

  // rename-file → old path gone, new path holds the bytes.
  ws.send(encodeControl({
    type: "rename-file",
    oldName: "refs.bib",
    newName: "bibliography.bib",
  }));
  await waitFor(
    () =>
      !existsSync(join(projectDir, "refs.bib"))
      && existsSync(join(projectDir, "bibliography.bib")),
    "rename mirrored to disk",
    frames,
  );
  assert.equal(
    readFileSync(join(projectDir, "bibliography.bib"), "utf8"),
    REFS,
  );

  // delete-file → file gone on disk.
  ws.send(encodeControl({ type: "delete-file", name: "sec1.tex" }));
  await waitFor(
    () => !existsSync(join(projectDir, "sec1.tex")),
    "sec1.tex removed from disk",
    frames,
  );

  await closeClient(ws, app);
}

// --- Run 2: cold restart — pre-seeded blob reaches disk at hydration.
// Pre-seed `sec1.tex` with content the in-process server has never
// seen. On boot the persistence hydrates the Y.Text from the blob
// AND mirrors the file to disk before `awaitHydrated()` resolves.
// We assert via the on-disk file rather than the compile output (the
// FixtureCompiler ignores source, but the workspace mirror is what
// we're locking here).
{
  const SEC1 = "% pre-seeded section\nseed body\n";
  await seedFile(blobStore, projectId, "sec1.tex", SEC1);

  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-mirror-cold-"));
  const projectDir = join(scratchRoot, projectId);
  const app = await startServer({ blobStore, scratchRoot });
  const { ws, frames } = await bootClient(app, projectId);

  // The hydration block mirrors every non-main file to disk; client
  // connect awaits hydration before broadcasting the initial state.
  await waitFor(
    () => existsSync(join(projectDir, "sec1.tex")),
    "sec1.tex mirrored from cold-boot blob via hydration",
    frames,
  );
  assert.equal(readFileSync(join(projectDir, "sec1.tex"), "utf8"), SEC1);

  // main.tex itself is also on disk (writeMain runs from runCompile).
  await waitFor(
    () => existsSync(join(projectDir, "main.tex")),
    "main.tex mirrored too",
    frames,
  );

  await closeClient(ws, app);
}

console.log("sidecar workspace-mirror test: OK");
