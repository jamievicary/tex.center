// Unit-tests `ProjectWorkspace`: lazy mkdir, atomic main.tex
// writes, dispose removes the dir, projectId validation. M23.1
// also locks writeFile / deleteFile / renameFile against the
// slashed-paths + atomic-write + empty-parent-reap pattern.

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
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

{
  // writeFile creates flat-name files atomically and overwrites cleanly.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "m23-flat" });
  await ws.writeFile("sec1.tex", "section one\n");
  assert.equal(readFileSync(join(ws.dir, "sec1.tex"), "utf8"), "section one\n");

  await ws.writeFile("sec1.tex", "section one v2\n");
  assert.equal(readFileSync(join(ws.dir, "sec1.tex"), "utf8"), "section one v2\n");

  // No leftover .tmp file after a successful write.
  assert.deepEqual(readdirSync(ws.dir).sort(), ["sec1.tex"]);

  await ws.dispose();
}

{
  // writeFile on slashed names mkdir -p's the parent directories.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "m23-nested" });
  await ws.writeFile("chapters/intro.tex", "intro\n");
  await ws.writeFile("chapters/sub/deep.tex", "deep\n");
  assert.equal(
    readFileSync(join(ws.dir, "chapters", "intro.tex"), "utf8"),
    "intro\n",
  );
  assert.equal(
    readFileSync(join(ws.dir, "chapters", "sub", "deep.tex"), "utf8"),
    "deep\n",
  );

  // deleteFile on the deepest leaf reaps `chapters/sub/` and
  // `chapters/` is left intact because `intro.tex` still lives there.
  await ws.deleteFile("chapters/sub/deep.tex");
  assert.equal(
    await stat(join(ws.dir, "chapters", "sub")).then(() => true, () => false),
    false,
  );
  assert.equal(
    await stat(join(ws.dir, "chapters", "intro.tex")).then(() => true, () => false),
    true,
  );

  // Deleting the last file under `chapters/` reaps it too — but not
  // the project work dir itself.
  await ws.deleteFile("chapters/intro.tex");
  assert.equal(
    await stat(join(ws.dir, "chapters")).then(() => true, () => false),
    false,
  );
  assert.equal(existsSync(ws.dir), true);

  // Deleting a non-existent file is a no-op.
  await ws.deleteFile("does-not-exist.tex");

  await ws.dispose();
}

{
  // renameFile moves across directory boundaries and reaps the
  // emptied source parent.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "m23-rename" });
  await ws.writeFile("chapters/intro.tex", "intro\n");
  await ws.renameFile("chapters/intro.tex", "intro.tex");

  assert.equal(
    await stat(join(ws.dir, "chapters")).then(() => true, () => false),
    false,
  );
  assert.equal(readFileSync(join(ws.dir, "intro.tex"), "utf8"), "intro\n");

  // Rename within a kept directory: the parent must survive.
  await ws.writeFile("chapters/a.tex", "a\n");
  await ws.writeFile("chapters/b.tex", "b\n");
  await ws.renameFile("chapters/a.tex", "chapters/a-renamed.tex");
  assert.deepEqual(readdirSync(join(ws.dir, "chapters")).sort(), [
    "a-renamed.tex",
    "b.tex",
  ]);

  // Rename to the same name is a silent no-op.
  await ws.renameFile("intro.tex", "intro.tex");
  assert.equal(readFileSync(join(ws.dir, "intro.tex"), "utf8"), "intro\n");

  await ws.dispose();
}

{
  // writeFile / deleteFile / renameFile validate names via the
  // shared protocol validator: traversal and bad shapes throw.
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "m23-validate" });
  await assert.rejects(() => ws.writeFile("../escape", "boom"));
  await assert.rejects(() => ws.writeFile("a/", "boom"));
  await assert.rejects(() => ws.writeFile("a//b", "boom"));
  await assert.rejects(() => ws.writeFile("", "boom"));
  await assert.rejects(() => ws.deleteFile("../escape"));
  await assert.rejects(() => ws.renameFile("ok.tex", "../bad"));
  await ws.dispose();
}

console.log("workspace test: OK");
