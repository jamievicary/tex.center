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
        text:
          event.shipoutPage !== undefined && event.shipoutPage > 0
            ? `[${event.shipoutPage}.out] ${event.bytes} bytes`
            : `${event.bytes} bytes`,
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
    case "outgoing-viewing-page":
      return {
        category: "debug-green",
        text: `viewing-page ${event.page}`,
        aggregateKey: "debug:outgoing-viewing-page",
      };
    case "outgoing-create-file":
      return {
        category: "debug-green",
        text: `create-file ${event.name}`,
        aggregateKey: "debug:outgoing-create-file",
      };
    case "outgoing-upload-file":
      return {
        category: "debug-green",
        text: `upload-file ${event.name} ${event.bytes}B`,
        aggregateKey: "debug:outgoing-upload-file",
      };
    case "outgoing-delete-file":
      return {
        category: "debug-green",
        text: `delete-file ${event.name}`,
        aggregateKey: "debug:outgoing-delete-file",
      };
    case "outgoing-rename-file":
      return {
        category: "debug-green",
        text: `rename-file ${event.oldName} → ${event.newName}`,
        aggregateKey: "debug:outgoing-rename-file",
      };
  }
}

/**
 * Resolves the initial debug-mode flag at editor mount (M22.4a).
 *
 * Source of truth is now `EditorSettings.debugMode` in
 * `localStorage["editor-settings"]`; URL `?debug=1/0` and
 * Ctrl+Shift+D all converge on writing that single key. The
 * caller passes the parsed `settingsDebug` value and persists
 * the returned `debug` back into settings when `shouldPersist`
 * is `true`.
 *
 * Migration: an existing `localStorage["debug"]` key (the M9
 * representation) is consumed on first call — its value (`"1"`
 * or `"0"`) overrides the default but loses to a URL override.
 * The key is removed after reading so subsequent loads see only
 * the settings object.
 *
 * Pure other than the localStorage read/remove. Tests pass a
 * fake `URLSearchParams` and `Storage`.
 */
export interface DebugModeResolution {
  debug: boolean;
  /** True when the editor should write `debug` back into settings. */
  shouldPersist: boolean;
}

export function initDebugMode(
  params: URLSearchParams,
  storage: Pick<Storage, "getItem" | "removeItem">,
  settingsDebug: boolean,
): DebugModeResolution {
  const legacyRaw = storage.getItem("debug");
  let migrated: boolean | null = null;
  if (legacyRaw !== null) {
    if (legacyRaw === "1") migrated = true;
    else if (legacyRaw === "0") migrated = false;
    storage.removeItem("debug");
  }

  const fromUrl = params.get("debug");
  if (fromUrl === "1") return { debug: true, shouldPersist: true };
  if (fromUrl === "0") return { debug: false, shouldPersist: true };

  if (migrated !== null) return { debug: migrated, shouldPersist: true };

  return { debug: settingsDebug, shouldPersist: false };
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
