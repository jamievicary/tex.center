// Pure keyboard-shortcut policy for file-tree rows (M11.2a).
//
// `FileTree.svelte` calls `decideFileRowAction` from the file row's
// `keydown` handler with the row's path. The helper returns the
// intended action — "rename" or "delete" — or null if the key
// should be left to default handling. The .svelte file then runs
// the matching imperative flow (`promptRename`, or
// `window.confirm` + `onDeleteFile`).
//
// Why a pure helper: keeps the visibility rules (no rename/delete
// on `MAIN_DOC_NAME`, modifier keys suppress) unit-testable
// without DOM. Mirrors the inline rules used by the `✎` / `×`
// buttons today.

export type FileRowAction = "rename" | "delete";

export interface KeyDescriptor {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function decideFileRowAction(
  ev: KeyDescriptor,
  path: string,
  mainDocName: string,
): FileRowAction | null {
  if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return null;
  if (path === mainDocName) return null;
  if (ev.key === "F2") return "rename";
  if (ev.key === "Delete" || ev.key === "Backspace") return "delete";
  return null;
}
