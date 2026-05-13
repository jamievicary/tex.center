// Per-project compile coalescer (per `172_answer.md` items 2/3/5).
//
// The pre-coalescer sidecar gated only on a pending debounce
// timer, so a doc-update arriving during an in-flight compile
// reached the underlying compiler and tripped its "another
// compile already in flight" guard. This class is an
// edge-triggered state machine that holds two booleans plus a
// debounce timer; bursts of `kick()` calls collapse into "the
// in-flight compile + at most one queued follow-up", and the
// `run` callback is never invoked overlappingly.
//
// `highestEmittedShipoutPage` is a public field the caller bumps
// after broadcasting a segment; `kickForView` consults it so a
// viewer scrolling past the last emitted page triggers a fresh
// compile even when no doc-updates are flowing.

export interface CompileCoalescerOptions {
  debounceMs: number;
  run: () => Promise<void>;
}

export class CompileCoalescer {
  highestEmittedShipoutPage = 0;

  private readonly debounceMs: number;
  private readonly run: () => Promise<void>;
  private inFlight = false;
  private pending = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CompileCoalescerOptions) {
    this.debounceMs = opts.debounceMs;
    this.run = opts.run;
  }

  // Mark a compile as wanted and (re)start the debounce window. If
  // a compile is already in flight, the flag is sufficient — the
  // in-flight run re-arms the debounce in its `finally`.
  kick(): void {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.maybeFire();
    }, this.debounceMs);
  }

  // View-only fire-through: only kicks when the path is genuinely
  // idle (no in-flight, no pending) — bursts of view frames during
  // a compile are absorbed by the standard pending mechanism.
  kickForView(maxViewingPage: number): void {
    if (this.inFlight) return;
    if (this.pending) return;
    if (maxViewingPage <= this.highestEmittedShipoutPage) return;
    this.kick();
  }

  // Cancel any pending debounce timer. Safe to call on shutdown
  // or when the last viewer disconnects.
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private maybeFire(): void {
    if (this.inFlight) return;
    if (!this.pending) return;
    this.pending = false;
    this.inFlight = true;
    void this.run().finally(() => {
      this.inFlight = false;
      // A doc-update arrived during the round → schedule another.
      // Goes through the debounce so an in-progress burst still
      // collapses; the timer fires almost immediately if no new
      // updates arrive afterwards.
      if (this.pending && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.maybeFire();
        }, this.debounceMs);
      }
    });
  }
}
