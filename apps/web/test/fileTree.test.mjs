// Unit test for `buildFileTree` — the pure path-grouping function
// underpinning the M11.1 collapsible tree. Today's server validates
// out `/`-containing names, so the practical inputs are flat lists;
// the function is exercised with nested paths as well to lock in the
// M11.3 virtual-folder semantics before the validator is relaxed.

import assert from "node:assert/strict";

const { buildFileTree } = await import("../src/lib/fileTree.ts");

function summarise(nodes) {
  return nodes.map((n) =>
    n.kind === "folder"
      ? { folder: n.name, path: n.path, children: summarise(n.children) }
      : { file: n.name, path: n.path },
  );
}

// 1. Empty input.
{
  const out = buildFileTree([]);
  assert.deepEqual(out, []);
}

// 2. Single flat file.
{
  const out = buildFileTree(["main.tex"]);
  assert.deepEqual(summarise(out), [{ file: "main.tex", path: "main.tex" }]);
}

// 3. Multiple flat files, sorted alphabetically.
{
  const out = buildFileTree(["zeta.tex", "alpha.tex", "main.tex"]);
  assert.deepEqual(summarise(out), [
    { file: "alpha.tex", path: "alpha.tex" },
    { file: "main.tex", path: "main.tex" },
    { file: "zeta.tex", path: "zeta.tex" },
  ]);
}

// 4. One nested file — folder materialises.
{
  const out = buildFileTree(["chapters/intro.tex"]);
  assert.deepEqual(summarise(out), [
    {
      folder: "chapters",
      path: "chapters",
      children: [{ file: "intro.tex", path: "chapters/intro.tex" }],
    },
  ]);
}

// 5. Mixed flat + nested. Folders sorted before files within each
//    level; alphabetic inside each kind.
{
  const out = buildFileTree([
    "main.tex",
    "chapters/intro.tex",
    "chapters/two.tex",
    "appendix.tex",
    "img/diag.png",
  ]);
  assert.deepEqual(summarise(out), [
    {
      folder: "chapters",
      path: "chapters",
      children: [
        { file: "intro.tex", path: "chapters/intro.tex" },
        { file: "two.tex", path: "chapters/two.tex" },
      ],
    },
    {
      folder: "img",
      path: "img",
      children: [{ file: "diag.png", path: "img/diag.png" }],
    },
    { file: "appendix.tex", path: "appendix.tex" },
    { file: "main.tex", path: "main.tex" },
  ]);
}

// 6. Deeper nesting.
{
  const out = buildFileTree(["a/b/c/leaf.tex", "a/b/sibling.tex"]);
  assert.deepEqual(summarise(out), [
    {
      folder: "a",
      path: "a",
      children: [
        {
          folder: "b",
          path: "a/b",
          children: [
            {
              folder: "c",
              path: "a/b/c",
              children: [{ file: "leaf.tex", path: "a/b/c/leaf.tex" }],
            },
            { file: "sibling.tex", path: "a/b/sibling.tex" },
          ],
        },
      ],
    },
  ]);
}

// 7. Malformed (empty segment / empty string) inputs are skipped.
{
  const out = buildFileTree(["", "a//b.tex", "/leading.tex", "trailing/", "ok.tex"]);
  assert.deepEqual(summarise(out), [{ file: "ok.tex", path: "ok.tex" }]);
}

// 8. Duplicate paths collapse to one node.
{
  const out = buildFileTree(["dup.tex", "dup.tex", "dir/x.tex", "dir/x.tex"]);
  assert.deepEqual(summarise(out), [
    {
      folder: "dir",
      path: "dir",
      children: [{ file: "x.tex", path: "dir/x.tex" }],
    },
    { file: "dup.tex", path: "dup.tex" },
  ]);
}

// 9. File-vs-folder collision: a file `foo` already exists, then a
//    later `foo/bar` arrives; the first-seen file wins and the
//    longer path is dropped (we don't silently mutate the earlier
//    node).
{
  const out = buildFileTree(["foo", "foo/bar.tex"]);
  assert.deepEqual(summarise(out), [{ file: "foo", path: "foo" }]);
}

console.log("ok fileTree.test.mjs");
