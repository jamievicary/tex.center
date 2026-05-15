// Editor settings persisted in `localStorage["editor-settings"]`
// as a single JSON object — one key for all future settings so we
// don't fragment the keyspace. Pure parse/serialize/clamp helpers
// live here; the Svelte component owns the reactive `$state` and
// the localStorage I/O so this module remains SSR-safe and unit-
// testable without any DOM globals.

export interface EditorSettings {
  /** PDF cross-fade duration in ms; 0 disables the transition. */
  fadeMs: number;
  /** Debug-mode toast fan-out (M22.4a). Default on. */
  debugMode: boolean;
}

export const SETTINGS_STORAGE_KEY = "editor-settings";

export const FADE_MS_DEFAULT = 1000;
export const FADE_MS_MIN = 0;
export const FADE_MS_MAX = 3000;
/** Slider granularity. 50ms ≈ 0.05s steps per `293_answer.md`. */
export const FADE_MS_STEP = 50;

export const DEBUG_MODE_DEFAULT = true;

export const DEFAULT_SETTINGS: EditorSettings = {
  fadeMs: FADE_MS_DEFAULT,
  debugMode: DEBUG_MODE_DEFAULT,
};

export function clampFadeMs(ms: unknown): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return FADE_MS_DEFAULT;
  if (ms < FADE_MS_MIN) return FADE_MS_MIN;
  if (ms > FADE_MS_MAX) return FADE_MS_MAX;
  return ms;
}

function coerceDebugMode(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return DEBUG_MODE_DEFAULT;
}

/**
 * Parse a JSON-stringified `EditorSettings`. Tolerates: null,
 * malformed JSON, non-object payloads, missing or wrong-typed
 * fields. Each field falls back to its default; unknown extra
 * keys are dropped (so a future field rollback doesn't poison
 * the store).
 */
export function parseSettings(raw: string | null | undefined): EditorSettings {
  if (raw == null) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    fadeMs: clampFadeMs(obj.fadeMs),
    debugMode: coerceDebugMode(obj.debugMode),
  };
}

export function serializeSettings(s: EditorSettings): string {
  return JSON.stringify({
    fadeMs: clampFadeMs(s.fadeMs),
    debugMode: coerceDebugMode(s.debugMode),
  });
}
