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

export interface CoalescerTraceEvent {
  seq: number;
  event:
    | "kick"
    | "kickForView-skip"
    | "kickForView-fire"
    | "timer-fire"
    | "maybeFire-skip-inflight"
    | "maybeFire-skip-empty"
    | "run-start"
    | "run-finally"
    | "cancel";
  inFlight: boolean;
  pending: boolean;
  hasTimer: boolean;
}

export interface CompileCoalescerOptions {
  debounceMs: number;
  run: () => Promise<void>;
  /**
   * Optional structured trace sink. When set, the coalescer emits an
   * event for every state-machine transition (`kick`, `maybeFire`
   * entry decisions, `run` start, `.finally`, `cancel`). Gated by env
   * `SIDECAR_TRACE_COALESCER=1` at server-construction time; intended
   * for short-lived production diagnostics of the iter-221 "already
   * in flight" toast cluster (`.autodev/discussion/220_answer.md`).
   */
  trace?: (event: CoalescerTraceEvent) => void;
}

export class CompileCoalescer {
  highestEmittedShipoutPage = 0;

  private readonly debounceMs: number;
  private readonly run: () => Promise<void>;
  private readonly trace: ((event: CoalescerTraceEvent) => void) | undefined;
  private inFlight = false;
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(opts: CompileCoalescerOptions) {
    this.debounceMs = opts.debounceMs;
    this.run = opts.run;
    this.trace = opts.trace;
  }

  private emit(event: CoalescerTraceEvent["event"]): void {
    if (!this.trace) return;
    this.trace({
      seq: ++this.seq,
      event,
      inFlight: this.inFlight,
      pending: this.pending,
      hasTimer: this.timer !== null,
    });
  }

  // Mark a compile as wanted and (re)start the debounce window. If
  // a compile is already in flight, the flag is sufficient — the
  // in-flight run re-arms the debounce in its `finally`.
  kick(): void {
    this.pending = true;
    this.emit("kick");
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit("timer-fire");
      this.maybeFire();
    }, this.debounceMs);
  }

  // View-only fire-through: only kicks when the path is genuinely
  // idle (no in-flight, no pending) — bursts of view frames during
  // a compile are absorbed by the standard pending mechanism.
  kickForView(maxViewingPage: number): void {
    if (this.inFlight || this.pending) {
      this.emit("kickForView-skip");
      return;
    }
    if (maxViewingPage <= this.highestEmittedShipoutPage) {
      this.emit("kickForView-skip");
      return;
    }
    this.emit("kickForView-fire");
    this.kick();
  }

  // Cancel any pending debounce timer. Safe to call on shutdown
  // or when the last viewer disconnects.
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit("cancel");
  }

  private maybeFire(): void {
    if (this.inFlight) {
      this.emit("maybeFire-skip-inflight");
      return;
    }
    if (!this.pending) {
      this.emit("maybeFire-skip-empty");
      return;
    }
    this.pending = false;
    this.inFlight = true;
    this.emit("run-start");
    void this.run().finally(() => {
      this.inFlight = false;
      this.emit("run-finally");
      // A doc-update arrived during the round → schedule another.
      // Goes through the debounce so an in-progress burst still
      // collapses; the timer fires almost immediately if no new
      // updates arrive afterwards.
      if (this.pending && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.emit("timer-fire");
          this.maybeFire();
        }, this.debounceMs);
      }
    });
  }
}
