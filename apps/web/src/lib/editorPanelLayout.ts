// Pure layout math for the M12 draggable panel dividers in the
// editor route. The Svelte component owns the $state and DOM
// wiring; everything in this module is a pure value-in/value-out
// helper that can be unit-tested without a browser.
//
// Three columns — tree, editor, preview — with two dividers
// between them. Tree and preview hold absolute px widths in CSS
// custom properties; editor takes the remaining `1fr`. Minimum
// widths are defended on every drag and resize so the editor
// pane can never collapse below MIN_EDITOR_PX while space exists
// for it.

export const MIN_TREE_PX = 150;
export const MIN_PREVIEW_PX = 200;
export const MIN_EDITOR_PX = 200;
export const DIVIDER_PX = 4;
export const DEFAULT_TREE_PX = 220;

export interface PanelWidths {
  tree: number;
  preview: number;
}

interface StoredWidthsShape {
  tree?: unknown;
  preview?: unknown;
}

/**
 * Parse a `localStorage` payload from a previous `persistPanelWidths`
 * call. Returns the recovered values, applying min-width clamps so a
 * stored width below the floor doesn't pop out below the editor min
 * before `clampPanelWidths` ever runs. Unset keys come back as
 * `undefined`; malformed JSON yields `{}`.
 */
export function parseStoredWidths(raw: string | null): {
  tree?: number;
  preview?: number;
} {
  if (!raw) return {};
  let parsed: StoredWidthsShape;
  try {
    parsed = JSON.parse(raw) as StoredWidthsShape;
  } catch {
    return {};
  }
  const out: { tree?: number; preview?: number } = {};
  if (typeof parsed.tree === "number" && Number.isFinite(parsed.tree)) {
    out.tree = Math.max(MIN_TREE_PX, Math.round(parsed.tree));
  }
  if (typeof parsed.preview === "number" && Number.isFinite(parsed.preview)) {
    out.preview = Math.max(MIN_PREVIEW_PX, Math.round(parsed.preview));
  }
  return out;
}

/**
 * Serialise the widths for `localStorage`. Counterpart to
 * `parseStoredWidths`.
 */
export function serializeWidths(widths: PanelWidths): string {
  return JSON.stringify({ tree: widths.tree, preview: widths.preview });
}

/**
 * Clamp tree/preview widths to (a) their individual mins and (b) the
 * editor-min defence. `preview` may be `null` to mean "no persisted
 * preview width yet": the function picks a sensible initial value
 * from the remaining space.
 *
 * When the viewport is too narrow to give every column its minimum,
 * tree and preview fall back to their floors and the editor accepts
 * the squeeze — that's a degenerate path the M12 design accepts
 * over yanking columns invisible.
 */
export function clampPanelWidths(input: {
  tree: number;
  preview: number | null;
  total: number;
}): PanelWidths {
  const dividers = DIVIDER_PX * 2;
  let tree = input.tree;
  let preview =
    input.preview ??
    Math.max(MIN_PREVIEW_PX, Math.floor((input.total - tree - dividers) / 2));
  tree = Math.max(MIN_TREE_PX, tree);
  preview = Math.max(MIN_PREVIEW_PX, preview);
  const maxTree = input.total - dividers - MIN_EDITOR_PX - preview;
  if (maxTree < MIN_TREE_PX) {
    tree = MIN_TREE_PX;
    preview = MIN_PREVIEW_PX;
  } else if (tree > maxTree) {
    tree = maxTree;
  }
  const maxPreview = input.total - dividers - MIN_EDITOR_PX - tree;
  if (preview > maxPreview && maxPreview >= MIN_PREVIEW_PX) {
    preview = maxPreview;
  }
  return { tree, preview };
}

/**
 * `localStorage` key for a project's persisted widths. Centralised
 * here so the parse/persist call sites and any test fixtures agree
 * on the exact shape.
 */
export function widthsStorageKey(projectId: string): string {
  return `editor-widths:${projectId}`;
}
