// Unit test for `fileTreeHeadless` — the `@headless-tree/core`
// adapter that takes a `buildFileTree` forest and exposes a
// TreeInstance with synchronous data loading + caller-owned state.
// Scaffolding for M11.1c (iter 283); the UI integration (replacing
// `FileTreeNode.svelte`'s recursive markup) lands in a later
// iteration once the wiring is proved correct here.

import assert from "node:assert/strict";

const { buildFileTree } = await import("../src/lib/fileTree.ts");
const {
  FILE_TREE_ROOT_ID,
  buildFileItemMap,
  createFileTreeInstance,
} = await import("../src/lib/fileTreeHeadless.ts");

// 1. buildFileItemMap mirrors the forest shape, with a synthetic
//    root entry that owns the top-level ids.
{
  const forest = buildFileTree([
    "main.tex",
    "chapters/intro.tex",
    "chapters/sub/deep.tex",
    "notes.md",
  ]);
  const map = buildFileItemMap(forest);
  assert.equal(map.items.get(FILE_TREE_ROOT_ID).kind, "folder");
  assert.deepEqual(map.children.get(FILE_TREE_ROOT_ID), [
    "chapters",
    "main.tex",
    "notes.md",
  ]);
  assert.equal(map.items.get("chapters").kind, "folder");
  assert.deepEqual(map.children.get("chapters"), [
    "chapters/sub",
    "chapters/intro.tex",
  ]);
  assert.equal(map.items.get("chapters/sub").kind, "folder");
  assert.deepEqual(map.children.get("chapters/sub"), ["chapters/sub/deep.tex"]);
  assert.equal(map.items.get("main.tex").kind, "file");
  assert.equal(map.items.get("chapters/sub/deep.tex").kind, "file");
}

// 2. createFileTreeInstance produces a TreeInstance whose visible
//    items mirror the expansion state. With nothing expanded, only
//    the top-level rows appear; expanding a folder reveals its
//    children.
{
  const forest = buildFileTree([
    "main.tex",
    "chapters/intro.tex",
    "chapters/sub/deep.tex",
  ]);
  const stateLog = [];
  const tree = createFileTreeInstance(forest, {
    onStateChange: (s) => stateLog.push(s),
  });

  const initialIds = tree.getItems().map((i) => i.getId());
  assert.deepEqual(initialIds, ["chapters", "main.tex"]);
  assert.equal(tree.getItemInstance("chapters").isExpanded(), false);

  tree.getItemInstance("chapters").expand();
  assert.equal(tree.getItemInstance("chapters").isExpanded(), true);
  const afterExpand = tree.getItems().map((i) => i.getId());
  assert.deepEqual(afterExpand, [
    "chapters",
    "chapters/sub",
    "chapters/intro.tex",
    "main.tex",
  ]);

  tree.getItemInstance("chapters/sub").expand();
  const afterDeepExpand = tree.getItems().map((i) => i.getId());
  assert.deepEqual(afterDeepExpand, [
    "chapters",
    "chapters/sub",
    "chapters/sub/deep.tex",
    "chapters/intro.tex",
    "main.tex",
  ]);

  tree.getItemInstance("chapters").collapse();
  const afterCollapse = tree.getItems().map((i) => i.getId());
  assert.deepEqual(afterCollapse, ["chapters", "main.tex"]);

  assert.ok(stateLog.length >= 3, "onStateChange fires for each mutation");
  const last = stateLog[stateLog.length - 1];
  assert.ok(Array.isArray(last.expandedItems));
  assert.deepEqual(last.expandedItems, ["chapters/sub"]);
}

// 3. Initial state carries through: a preset expansion lets the
//    caller hydrate from localStorage without an extra mutation
//    round-trip.
{
  const forest = buildFileTree(["chapters/intro.tex", "main.tex"]);
  const tree = createFileTreeInstance(forest, {
    initialExpanded: ["chapters"],
    initialSelected: ["main.tex"],
  });
  assert.equal(tree.getItemInstance("chapters").isExpanded(), true);
  const ids = tree.getItems().map((i) => i.getId());
  assert.deepEqual(ids, ["chapters", "chapters/intro.tex", "main.tex"]);
  // selectionFeature exposes the selected items via getState().
  assert.deepEqual(tree.getState().selectedItems, ["main.tex"]);
}

// 4. onPrimaryAction fires with the path when an item is "opened"
//    (e.g. Enter key, double-click). The caller wires this to the
//    editor's file-select callback.
{
  const forest = buildFileTree(["main.tex", "notes.md"]);
  const opened = [];
  const tree = createFileTreeInstance(forest, {
    onPrimaryAction: (path) => opened.push(path),
  });
  tree.getItemInstance("notes.md").primaryAction();
  tree.getItemInstance("main.tex").primaryAction();
  assert.deepEqual(opened, ["notes.md", "main.tex"]);
}

console.log("fileTreeHeadless.test.mjs OK");
