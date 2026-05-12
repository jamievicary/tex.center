// Debug-mode protocol fan-out for the editor (M9.editor-ux).
//
// Maps `WsDebugEvent`s onto the toast store using the colour
// categories from `.autodev/discussion/174_answer.md`:
//
//   pdf-segment           → debug-blue
//   outgoing-doc-update   → debug-green (Yjs op)
//   compile-status        → debug-orange
//   file-list / hello     → debug-grey
//   file-op-error         → debug-red
//
// Aggregation keys collapse bursts into a single `×N` toast
// within the toast store's 500ms aggregation window. Per-event
// keying:
//
//  • pdf-segment / outgoing-doc-update / file-list / hello use a
//    single shared key per kind — typing produces bursts that
//    should coalesce.
//  • compile-status is keyed by `state` so `running` → `idle`
//    transitions surface as two distinct toasts but a `running`
//    burst coalesces.
//  • file-op-error is keyed by `reason` mirroring the user-
//    facing red toast in iter 186.

import type { ToastInput } from "./toastStore";
import type { WsDebugEvent } from "./wsClient";

export function debugEventToToast(event: WsDebugEvent): ToastInput {
  switch (event.kind) {
    case "pdf-segment":
      return {
        category: "debug-blue",
        text: `pdf-segment ${event.bytes}B`,
        aggregateKey: "debug:pdf-segment",
      };
    case "outgoing-doc-update":
      return {
        category: "debug-green",
        text: `Yjs op ${event.bytes}B`,
        aggregateKey: "debug:yjs-op",
      };
    case "compile-status":
      return {
        category: "debug-orange",
        text: event.detail
          ? `compile-status ${event.state}: ${event.detail}`
          : `compile-status ${event.state}`,
        aggregateKey: `debug:compile-status:${event.state}`,
      };
    case "file-list":
      return {
        category: "debug-grey",
        text: `file-list (${event.count})`,
        aggregateKey: "debug:file-list",
      };
    case "hello":
      return {
        category: "debug-grey",
        text: `hello proto=${event.protocol}`,
        aggregateKey: "debug:hello",
      };
    case "file-op-error":
      return {
        category: "debug-red",
        text: `file-op-error: ${event.reason}`,
        aggregateKey: `debug:file-op-error:${event.reason}`,
      };
  }
}

/**
 * Computes the initial debug-mode flag from URL search params and
 * localStorage. `?debug=1` flips localStorage on for the session
 * so subsequent navigations stay in debug mode; `?debug=0` flips
 * it off. With no `debug` param, falls back to the persisted
 * localStorage value.
 *
 * Pure other than the localStorage read/write — exposed for the
 * editor page to call in `onMount` and for unit tests via fake
 * `URLSearchParams` and `Storage`.
 */
export function initDebugFlag(
  params: URLSearchParams,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const fromUrl = params.get("debug");
  if (fromUrl === "1") {
    storage.setItem("debug", "1");
    return true;
  }
  if (fromUrl === "0") {
    storage.setItem("debug", "0");
    return false;
  }
  return storage.getItem("debug") === "1";
}

/**
 * Installs the Ctrl+Shift+D keyboard toggle. Returns the cleanup
 * function. `setDebug` receives the new state after toggling;
 * the caller is responsible for persisting it (e.g. via
 * `localStorage.setItem`) and for re-rendering anything that
 * depends on it.
 */
export function onDebugKeyShortcut(
  target: { addEventListener: Window["addEventListener"]; removeEventListener: Window["removeEventListener"] },
  getDebug: () => boolean,
  setDebug: (next: boolean) => void,
): () => void {
  const handler = (ev: Event): void => {
    const ke = ev as KeyboardEvent;
    if (!ke.ctrlKey || !ke.shiftKey) return;
    if (ke.key !== "D" && ke.key !== "d") return;
    ke.preventDefault();
    setDebug(!getDebug());
  };
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
