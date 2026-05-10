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
}

export interface CompileRequest {
  source: string;
  targetPage: number;
}

export interface CompileSuccess {
  ok: true;
  segments: PdfSegment[];
}

export interface CompileFailure {
  ok: false;
  error: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface Compiler {
  compile(req: CompileRequest): Promise<CompileResult>;
  close(): Promise<void>;
}
