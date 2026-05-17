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
  /**
   * Engine end-of-document signal for this compile round: `true`
   * when the upstream `[pdf-end]` daemon event was observed (the
   * engine reached `\enddocument`), `false` when the round
   * completed without it, `undefined` when the compiler does not
   * expose the signal. Stamped by `SupertexDaemonCompiler` per
   * round and forwarded to the wire via `encodePdfSegment`.
   */
  lastPage?: boolean;
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
  /**
   * Mirrors `PdfSegment.lastPage` at the round level: `true` if the
   * round observed `[pdf-end]`, `false` if it completed without it,
   * `undefined` if the compiler doesn't expose the signal. Sidecar
   * iter B will consume this on the FE to gate scroll-driven page
   * demand-fetches.
   */
  lastPage?: boolean;
  /**
   * First page invalidated by an edit detected this round, sourced
   * from the upstream `[dirty D]` line (M27). Pages D..onwards are
   * stale until a subsequent `recompile,N` re-emits them. The
   * chunks shipped in *this* round (D..maxShipout) already carry
   * the post-edit contents; the FE typically combines the two and
   * treats `max(D, maxShipout + 1)` as the dirty frontier.
   * `undefined` when no edit was detected in the round (every
   * vanilla `recompile,T` advance round) or the compiler does not
   * expose the signal.
   */
  dirtyPage?: number;
}

export interface CompileFailure {
  ok: false;
  error: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface Compiler {
  /**
   * M20.3(a)2 cold-start gate. When `false`, the sidecar skips
   * the cold-boot checkpoint blob GET in `ensureRestored` and the
   * idle-stop `snapshot()`+PUT in `persistAllCheckpoints`. All
   * three current implementations return `null` from `snapshot()`
   * (and accept any blob in `restore()` as a no-op) because
   * upstream supertex does not yet expose a serialise wire on the
   * daemon protocol (M7.4.2), so on every cold boot the GET costs
   * wallclock (~0.27 s against Tigris/`fra` per iter-330 capture)
   * for guaranteed-null bytes.
   *
   * Flip to `true` once the implementation produces real snapshot
   * bytes the next `restore()` will consume; the wiring is
   * otherwise unchanged and remains pinned by
   * `serverCheckpointWiring.test.mjs`.
   */
  readonly supportsCheckpoint: boolean;
  compile(req: CompileRequest): Promise<CompileResult>;
  close(): Promise<void>;
  /**
   * M20.3(a) cold-start hook. Called eagerly at project-state
   * creation time so any one-shot startup work (e.g. spawning a
   * supertex daemon child and waiting for its `.fmt` load to
   * complete) overlaps with the WS handshake + Yjs hydration +
   * checkpoint restore phases rather than serialising behind
   * them inside the first `compile()`. Must be idempotent: a
   * subsequent `compile()` (and a subsequent `warmup()`) must
   * await the same in-flight promise and not re-do the work.
   *
   * Implementations with nothing to pre-do return a resolved
   * promise (e.g. `FixtureCompiler`, `SupertexOnceCompiler`).
   * Errors should surface from the caller-awaitable promise; the
   * sidecar logs and ignores them — the next `compile()` will
   * retry from scratch.
   */
  warmup(): Promise<void>;
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
