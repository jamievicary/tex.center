// Compile-cycle elapsed-time tracker (M22.4a + M22.4b).
//
// Wraps `debugEventToToast` to prefix `compile-status idle` /
// `compile-status error` AND `pdf-segment` toasts with the elapsed
// time since the cycle's `compile-status running`. The wire shape is:
//
//   compile-status running  →  [0 or 1] pdf-segment  →  compile-status idle
//
// On each `running` we reset the timer; subsequent same-cycle
// events report their delta. Cycles are independent: cycle N+1
// does not inherit cycle N's start. A stray prefixable event
// without a preceding `running` passes through unprefixed.
//
// Pure module, injectable clock. SSR-safe, no DOM.

import { debugEventToToast } from "./debugToasts";
import type { ToastInput } from "./toastStore";
import type { WsDebugEvent } from "./wsClient";

export interface CompileCycleTracker {
  observe(event: WsDebugEvent): ToastInput;
}

export interface CompileCycleTrackerOptions {
  /** Injectable for unit tests; defaults to `Date.now`. */
  now?: () => number;
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
}

export function createCompileCycleTracker(
  opts: CompileCycleTrackerOptions = {},
): CompileCycleTracker {
  const now = opts.now ?? (() => Date.now());
  let cycleStart: number | null = null;

  function observe(event: WsDebugEvent): ToastInput {
    const base = debugEventToToast(event);
    if (event.kind === "compile-status") {
      if (event.state === "running") {
        cycleStart = now();
        return base;
      }
      if (event.state !== "idle" && event.state !== "error") return base;
      if (cycleStart === null) return base;
      const elapsed = now() - cycleStart;
      cycleStart = null;
      return { ...base, text: `${formatElapsed(elapsed)} — ${base.text}` };
    }
    if (event.kind === "pdf-segment" && cycleStart !== null) {
      const elapsed = now() - cycleStart;
      return { ...base, text: `${formatElapsed(elapsed)} — ${base.text}` };
    }
    return base;
  }

  return { observe };
}
