// `@headless-tree/core` adapter for the file tree (M11.1c-prep).
//
// `@headless-tree/core` is framework-agnostic; there is no
// `@headless-tree/svelte` package despite an earlier survey
// (`260_answer.md`) claiming otherwise (verified iter 283). This
// module wraps `createTree(...)` with the data-loader shape derived
// from `buildFileTree`'s forest, so callers feed in our existing
// `FileTreeNode[]` and receive a TreeInstance with synchronous
// children, expand/select state plumbed through a caller-supplied
// state setter. UI wiring lives one layer up (M11.1c proper).
//
// State is owned by the caller — `createFileTreeInstance` accepts an
// initial snapshot and an `onSetState` callback invoked on every
// state mutation. Re-render plumbing (Svelte 5 `$state`, React
// `useState`, etc.) is the caller's responsibility; the adapter is
// framework-agnostic so it can be unit-tested under tsx without a
// DOM.

import {
  createTree,
  syncDataLoaderFeature,
  selectionFeature,
  type ItemInstance,
  type TreeInstance,
  type TreeState,
} from "@headless-tree/core";
import type { FileTreeNode } from "./fileTree.js";

export interface FileItemData {
  name: string;
  path: string;
  kind: "file" | "folder";
}

export const FILE_TREE_ROOT_ID = "__root__";

export interface FileItemMap {
  items: ReadonlyMap<string, FileItemData>;
  children: ReadonlyMap<string, readonly string[]>;
}

export function buildFileItemMap(forest: readonly FileTreeNode[]): FileItemMap {
  const items = new Map<string, FileItemData>();
  const children = new Map<string, string[]>();
  items.set(FILE_TREE_ROOT_ID, {
    name: "",
    path: "",
    kind: "folder",
  });
  const rootChildren: string[] = [];
  children.set(FILE_TREE_ROOT_ID, rootChildren);

  function walk(node: FileTreeNode, parent: string[]): void {
    parent.push(node.path);
    if (node.kind === "folder") {
      items.set(node.path, {
        name: node.name,
        path: node.path,
        kind: "folder",
      });
      const mine: string[] = [];
      children.set(node.path, mine);
      for (const child of node.children) walk(child, mine);
    } else {
      items.set(node.path, {
        name: node.name,
        path: node.path,
        kind: "file",
      });
    }
  }

  for (const top of forest) walk(top, rootChildren);
  return { items, children };
}

export interface CreateFileTreeInstanceOptions {
  initialExpanded?: readonly string[];
  initialSelected?: readonly string[];
  initialFocused?: string | null;
  onStateChange?: (next: Readonly<Partial<TreeState<FileItemData>>>) => void;
  onPrimaryAction?: (path: string) => void;
}

export function createFileTreeInstance(
  forest: readonly FileTreeNode[],
  opts: CreateFileTreeInstanceOptions = {},
): TreeInstance<FileItemData> {
  const map = buildFileItemMap(forest);

  let state: Partial<TreeState<FileItemData>> = {
    expandedItems: [...(opts.initialExpanded ?? [])],
    selectedItems: [...(opts.initialSelected ?? [])],
    focusedItem: opts.initialFocused ?? null,
  };

  const config: import("@headless-tree/core").TreeConfig<FileItemData> = {
    rootItemId: FILE_TREE_ROOT_ID,
    getItemName: (item: ItemInstance<FileItemData>) => item.getItemData().name,
    isItemFolder: (item: ItemInstance<FileItemData>) =>
      item.getItemData().kind === "folder",
    dataLoader: {
      getItem: (id: string) => {
        const data = map.items.get(id);
        if (!data) throw new Error(`fileTreeHeadless: unknown item "${id}"`);
        return data;
      },
      getChildren: (id: string) => [...(map.children.get(id) ?? [])],
    },
    state,
    setState: (updater) => {
      const next =
        typeof updater === "function"
          ? (updater as (prev: typeof state) => typeof state)(state)
          : updater;
      state = next;
      opts.onStateChange?.(state);
    },
    features: [syncDataLoaderFeature, selectionFeature],
  };
  if (opts.onPrimaryAction) {
    const cb = opts.onPrimaryAction;
    config.onPrimaryAction = (item: ItemInstance<FileItemData>) =>
      cb(item.getItemData().path);
  }
  const tree = createTree<FileItemData>(config);

  // Without a mounted DOM element the tree defers its first
  // rebuild; flip the flag manually so `getItems()` / `expand()` /
  // `collapse()` work synchronously. UI-side callers that register
  // a real element can call `tree.registerElement(...)` themselves;
  // calling `setMounted(true)` here is idempotent with that path.
  tree.setMounted(true);
  tree.rebuildTree();
  return tree;
}
