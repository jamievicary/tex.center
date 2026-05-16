// Pure context-menu policy for the file tree (M11.2b).
//
// `FileTree.svelte` opens a small menu on `contextmenu` events. The
// menu items depend on the target: a file row offers Rename/Delete
// (greyed for `MAIN_DOC_NAME`, which is non-renamable + non-deletable
// to mirror the inline `✎` / `×` button guards); the root container
// (empty space inside the tree column) offers a single New file
// item.
//
// Keyboard policy: ArrowUp/ArrowDown move focus across enabled items,
// wrapping at the ends; Enter or Space activates the focused item;
// Escape dismisses. Everything else returns null so the caller can
// fall through to default handling.
//
// Pure so it can be unit-tested without a DOM.

export type MenuAction = "create" | "rename" | "delete";

export interface MenuItem {
  readonly action: MenuAction;
  readonly label: string;
  readonly enabled: boolean;
}

export function menuItemsForFile(
  path: string,
  mainDocName: string,
): MenuItem[] {
  const isMain = path === mainDocName;
  return [
    { action: "rename", label: "Rename…", enabled: !isMain },
    { action: "delete", label: "Delete", enabled: !isMain },
  ];
}

export function menuItemsForRoot(): MenuItem[] {
  return [{ action: "create", label: "New file…", enabled: true }];
}

export type MenuKeyAction =
  | { kind: "prev" }
  | { kind: "next" }
  | { kind: "activate" }
  | { kind: "dismiss" };

export interface KeyDescriptor {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function decideMenuKeyAction(
  ev: KeyDescriptor,
): MenuKeyAction | null {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  if (ev.key === "Escape") return { kind: "dismiss" };
  if (ev.key === "ArrowUp") return { kind: "prev" };
  if (ev.key === "ArrowDown") return { kind: "next" };
  if (ev.key === "Enter" || ev.key === " ") return { kind: "activate" };
  return null;
}

/**
 * Advance the focused index across `items` by `delta` (+1 next, -1
 * prev), skipping disabled entries and wrapping at the ends. Returns
 * the unchanged index if no enabled entry exists. Pure.
 */
export function moveMenuFocus(
  items: readonly MenuItem[],
  current: number,
  delta: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return current;
  if (!items.some((it) => it.enabled)) return current;
  let i = current;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (items[i]!.enabled) return i;
  }
  return current;
}

/**
 * Pick the initial focused index for a freshly opened menu — the
 * first enabled entry, or 0 if none are enabled (the menu still
 * opens; nothing is actionable, but Escape / click-out still work).
 */
export function initialMenuFocus(items: readonly MenuItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.enabled) return i;
  }
  return 0;
}
