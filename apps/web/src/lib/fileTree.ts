// Pure tree-grouping over `/`-separated file paths. Today the
// server's `validateProjectFileName` rejects names containing `/`,
// so every input is a single segment and the resulting forest is a
// flat list of file nodes; the parser is structured for the
// upcoming M11.3 virtual-folder model, where files like
// `chapters/intro.tex` materialise a `chapters/` folder node.

export type FileTreeNode =
  | { kind: "file"; name: string; path: string }
  | {
      kind: "folder";
      name: string;
      path: string;
      children: FileTreeNode[];
    };

interface MutableFolder {
  kind: "folder";
  name: string;
  path: string;
  // Insertion-ordered child map, materialised into an array on
  // freeze. Files and folders coexist here.
  children: Map<string, FileTreeNode | MutableFolder>;
}

function isMutableFolder(
  n: FileTreeNode | MutableFolder,
): n is MutableFolder {
  return n.kind === "folder" && n.children instanceof Map;
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function freeze(node: MutableFolder): FileTreeNode {
  const kids: FileTreeNode[] = [];
  for (const child of node.children.values()) {
    kids.push(isMutableFolder(child) ? freeze(child) : child);
  }
  kids.sort(compareNodes);
  return { kind: "folder", name: node.name, path: node.path, children: kids };
}

/**
 * Group a list of `/`-separated file paths into a forest.
 * Folders are sorted before files, alphabetic within each. A
 * malformed path (empty segment) is skipped — the server-side
 * validator is the authority, this is rendering only.
 */
export function buildFileTree(files: readonly string[]): FileTreeNode[] {
  const root: MutableFolder = {
    kind: "folder",
    name: "",
    path: "",
    children: new Map(),
  };

  outer: for (const raw of files) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const segments = raw.split("/");
    for (const seg of segments) {
      if (seg.length === 0) continue outer;
    }

    let cursor: MutableFolder = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const path = segments.slice(0, i + 1).join("/");
      const existing = cursor.children.get(seg);
      if (existing && isMutableFolder(existing)) {
        cursor = existing;
        continue;
      }
      // If a file already exists at this segment, the input is
      // inconsistent (`foo` and `foo/bar` collide). Skip the
      // longer path — the file wins by being first-seen.
      if (existing) continue outer;
      const next: MutableFolder = {
        kind: "folder",
        name: seg,
        path,
        children: new Map(),
      };
      cursor.children.set(seg, next);
      cursor = next;
    }
    const leaf = segments[segments.length - 1]!;
    if (cursor.children.has(leaf)) continue;
    cursor.children.set(leaf, { kind: "file", name: leaf, path: raw });
  }

  const frozen = freeze(root);
  return frozen.kind === "folder" ? frozen.children : [];
}
