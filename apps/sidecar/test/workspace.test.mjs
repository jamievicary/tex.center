// Unit-tests `ProjectWorkspace`: lazy mkdir, atomic main.tex
// writes, dispose removes the dir, projectId validation.

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectWorkspace } from "../src/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "ws-test-"));

{
  // init() is idempotent and creates the per-project dir under root.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "abc" });
  assert.equal(ws.dir, join(root, "abc"));
  assert.equal(existsSync(ws.dir), false);
  await ws.init();
  await ws.init();
  assert.equal(existsSync(ws.dir), true);
  await ws.dispose();
  assert.equal(existsSync(ws.dir), false);
}

{
  // writeMain creates the file via tmp+rename and overwrites cleanly.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "proj-1" });
  await ws.writeMain("\\documentclass{article}\\begin{document}hi\\end{document}");
  const target = ws.mainTexPath();
  assert.equal(readFileSync(target, "utf8").startsWith("\\documentclass"), true);

  await ws.writeMain("second");
  assert.equal(readFileSync(target, "utf8"), "second");

  // No leftover .tmp file after a successful write.
  const entries = readdirSync(ws.dir);
  assert.deepEqual(entries.sort(), ["main.tex"]);

  await ws.dispose();
}

{
  // Reject project IDs that could escape the root.
  assert.throws(() => new ProjectWorkspace({ rootDir: root, projectId: "../evil" }));
  assert.throws(() => new ProjectWorkspace({ rootDir: root, projectId: "" }));
  assert.throws(() => new ProjectWorkspace({ rootDir: root, projectId: "with space" }));
}

{
  // dispose() before init() is a no-op.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "neverused" });
  await ws.dispose();
  assert.equal(existsSync(ws.dir), false);
}

console.log("workspace test: OK");
