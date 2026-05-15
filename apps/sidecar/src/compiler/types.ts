// Compiler adapter — the sidecar's seam between its
// WebSocket-facing concerns and whatever produces PDF bytes for a
// given source. Today the only implementation is `FixtureCompiler`
// (returns a static hello-world PDF). M3 lands a `SupertexCompiler`
// that drives `vendor/supertex` in watch mode.
//
// Shape kept deliberately small: the sidecar holds the project's
// `Y.Text` and is responsible for serialising it to a source tree;
// the compiler takes a snapshot (top-level `.tex` source, plus the
// current viewing page) and emits zero-or-more PDF byte-range
// segments. Streaming progress is via async iterator so a future
// supertex adapter can yield per-shipout deltas without rebundling
// the API.

export interface PdfSegment {
  totalLength: number;
  offset: number;
  bytes: Uint8Array;
  /**
   * 1-based supertex shipout page this segment represents — the
   * `[N.out]` index. M22.4b carried this onto the wire so the
   * web client can render it in debug toasts; sidecar-internal
   * code can also use it (e.g. for the coalescer's
   * `highestEmittedShipoutPage` gate). Optional: compilers that
   * don't expose per-shipout structure leave it undefined.
   */
  shipoutPage?: number;
}

export interface CompileRequest {
  source: string;
  targetPage: number;
}

export interface CompileSuccess {
  ok: true;
  segments: PdfSegment[];
  /**
   * Highest shipout page produced by this compile, when the
   * implementation tracks it. The coalescer uses this to gate
   * view-only re-fires: if a `view` frame asks for a page that
   * exceeds the highest shipout we've ever emitted, the sidecar
   * issues a fresh compile even with no doc-updates. Optional —
   * implementations that don't expose per-shipout structure may
   * omit it (then the gate degrades to "doc-updates only").
   */
  shipoutPage?: number;
}

export interface CompileFailure {
  ok: false;
  error: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface Compiler {
  compile(req: CompileRequest): Promise<CompileResult>;
  close(): Promise<void>;
  /**
   * Serialise the compiler's current resumable state to an opaque
   * byte blob, or `null` if there is no resumable state to capture
   * (fresh compiler, or this implementation doesn't yet support
   * checkpoints). The bytes are persisted by the sidecar to the
   * project's blob store on idle-stop and fed back into
   * `restore()` when the per-project Machine next wakes.
   *
   * `snapshot()` must not mutate observable state — it is safe to
   * call between `compile()` rounds. Implementations that own
   * subprocesses should leave them running; this is a read, not a
   * teardown. Callers serialise externally; concurrent invocation
   * during an in-flight `compile()` is implementation-defined.
   */
  snapshot(): Promise<Uint8Array | null>;
  /**
   * Rehydrate compiler state from a blob previously produced by
   * `snapshot()`. Must be called before the first `compile()` to
   * be effective; calling after a compile has run is permitted
   * but implementation-defined.
   *
   * Implementations that don't yet support checkpoints accept any
   * blob and behave as a no-op (the next `compile()` rebuilds
   * from scratch). Implementations that do support checkpoints
   * must tolerate a blob from any prior version of themselves —
   * at worst falling back to a clean rebuild — so a sidecar
   * upgrade never poisons a stored checkpoint.
   */
  restore(blob: Uint8Array): Promise<void>;
}
