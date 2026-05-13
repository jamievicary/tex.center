// Editor lifecycle `performance.mark()` instrumentation (M13.1).
//
// Records well-defined transition points across an editor session
// so we can measure open→first-paint and edit→preview latency from
// the browser's Performance timeline. Marks are emitted via the
// platform `performance.mark()` API; observers (devtools, future
// debug-toast bridge, future local Playwright spec asserting
// ordering) read them via `performance.getEntriesByName(name)`.
//
// The full mark set planned by PLAN M13.1:
//
//   editor:route-mounted     — first paint of the editor route
//   editor:ws-open           — WsClient first 'connected' snapshot
//   editor:yjs-hydrated      — first `snapshot.hydrated` true
//   editor:first-text-paint  — first non-null Y.Text bound to CM
//   editor:first-pdf-segment — first non-null `snapshot.pdfBytes`
//
// This module ships the constants for all of them; the editor page
// wires them in over multiple iterations.

export const EDITOR_ROUTE_MOUNTED = "editor:route-mounted";
export const EDITOR_WS_OPEN = "editor:ws-open";
export const EDITOR_YJS_HYDRATED = "editor:yjs-hydrated";
export const EDITOR_FIRST_TEXT_PAINT = "editor:first-text-paint";
export const EDITOR_FIRST_PDF_SEGMENT = "editor:first-pdf-segment";

export type EditorMarkName =
  | typeof EDITOR_ROUTE_MOUNTED
  | typeof EDITOR_WS_OPEN
  | typeof EDITOR_YJS_HYDRATED
  | typeof EDITOR_FIRST_TEXT_PAINT
  | typeof EDITOR_FIRST_PDF_SEGMENT;

/**
 * Records `name` on the global Performance timeline at most once
 * per page load. Subsequent calls with the same name are no-ops —
 * lifecycle marks denote a *first* transition, so re-firing on
 * (e.g.) WS reconnect would muddy the signal. Safe to call in
 * environments without `performance.mark` (SSR, tests).
 */
export function markOnce(
  name: EditorMarkName,
  perf: Pick<Performance, "mark" | "getEntriesByName"> | undefined =
    typeof performance !== "undefined" ? performance : undefined,
): boolean {
  if (!perf) return false;
  if (perf.getEntriesByName(name).length > 0) return false;
  perf.mark(name);
  return true;
}
