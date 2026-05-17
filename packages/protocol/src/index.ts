// Wire protocol shared between apps/web (browser) and
// apps/sidecar (per-project server).
//
// Single-user MVP. Every WebSocket frame is binary, with a
// 1-byte leading tag identifying the message kind.
//
// Tags:
//   0x00 DOC_UPDATE      — Yjs document update bytes.
//   0x01 AWARENESS       — Yjs awareness update bytes (reserved;
//                          unused until multi-user collab).
//   0x10 CONTROL         — UTF-8 JSON control message (see ControlMessage).
//   0x20 PDF_SEGMENT     — Incremental PDF byte-range patch.
//
// PDF_SEGMENT body layout (big-endian):
//   u32 totalLength    — total length of the PDF after this patch.
//   u32 offset         — offset at which `bytes` is to be written.
//   u32 segmentLength  — `bytes.length`.
//   u32 shipoutPage    — 1-based supertex shipout page this segment
//                        represents (the `[N.out]` index). Sentinel
//                        `0` means "unknown" — the compiler did not
//                        attach a shipout index, so consumers should
//                        treat the segment as opaque w.r.t. paging.
//                        Added M22.4b; header width 13 → 17 bytes
//                        including the leading tag.
//   u8  lastPage       — engine end-of-document signal. `0` = unset
//                        (the compiler did not attach a value);
//                        `1` = false (more pages may follow);
//                        `2` = true (this round reached
//                        `\enddocument` so no further shipouts will
//                        come on this source). Sourced from the
//                        upstream `[pdf-end]` daemon event added in
//                        supertex `aaa625a`; full tri-state so
//                        compilers that don't know (Fixture) are
//                        distinguishable from compilers that
//                        explicitly observed "not the last page".
//                        Added iter A of the [pdf-end] slice;
//                        header width 17 → 18 bytes including the
//                        leading tag.
//   bytes              — raw PDF bytes for this segment.

export const PROTOCOL_VERSION = 1;

// The Yjs Y.Text key both sides agree on for the project's primary
// `.tex` source. Single-file MVP; M4 generalises to one Y.Text per
// file in the project tree, keyed by filename.
export const MAIN_DOC_NAME = "main.tex";

// Seed contents for a fresh project's `main.tex` — the canonical
// 4-line LaTeX hello-world. A newborn project has no source blob;
// the sidecar writes this into `Y.Text("main.tex")` (and persists
// it, if a blob store is wired) on first hydration so the first
// compile produces a meaningful PDF and the editor opens onto a
// non-empty document rather than a blinking cursor. Exact bytes
// are part of the wire contract — see test
// `apps/sidecar/test/persistenceSeed.test.mjs`.
export const MAIN_DOC_HELLO_WORLD =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Hello, world!\n" +
  "\\end{document}\n";

// Allowed characters for a single segment of a project-relative
// file name. Each `/`-separated segment must match this rule:
// reasonably URL-safe, no whitespace. The sidecar is the authority
// here (defence-in-depth); the rule lives in the shared protocol
// package so the web client can mirror it and surface validation
// errors immediately on the create/rename affordances rather than
// relying on a silent server-side reject.
const FILE_NAME_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const FILE_NAME_MAX_LEN = 128;

/**
 * Validate a project-relative filename. Multi-segment paths are
 * permitted (`chapters/intro.tex`); each `/`-separated segment must
 * satisfy the single-segment rule (non-empty, not `.`/`..`, and
 * matching `FILE_NAME_SEGMENT_RE`). Leading and trailing slashes,
 * empty segments, and overall length above `FILE_NAME_MAX_LEN` are
 * rejected. Returns a short human-readable reason when invalid,
 * otherwise `null`.
 */
export function validateProjectFileName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "empty name";
  if (name.length > FILE_NAME_MAX_LEN) return "name too long";
  if (name.startsWith("/") || name.endsWith("/")) {
    return "name must not start or end with '/'";
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return "empty segment";
    if (seg === "." || seg === "..") return "reserved segment";
    if (!FILE_NAME_SEGMENT_RE.test(seg)) return "name has disallowed characters";
  }
  return null;
}

export const TAG_DOC_UPDATE = 0x00;
export const TAG_AWARENESS = 0x01;
export const TAG_CONTROL = 0x10;
export const TAG_PDF_SEGMENT = 0x20;

export type ControlMessage =
  | { type: "hello"; protocol: number }
  | { type: "view"; page: number }
  | { type: "compile-status"; state: "idle" | "running" | "error"; detail?: string }
  | { type: "file-list"; files: string[] }
  | { type: "create-file"; name: string }
  | { type: "delete-file"; name: string }
  | { type: "rename-file"; oldName: string; newName: string }
  | { type: "upload-file"; name: string; content: string }
  | {
      type: "file-op-error";
      op: "create-file" | "delete-file" | "rename-file" | "upload-file";
      reason: string;
    }
  /**
   * Sidecar → web. Sourced from the upstream supertex daemon's
   * `[dirty D]` line (M27 protocol). Pages D..onwards of the
   * currently-rendered PDF are stale: they reflect the pre-edit
   * source, and their contents will only become fresh when a
   * subsequent `recompile,N` round re-emits chunks D..N. The FE
   * shows a translucent grey overlay + spinner on dirty pages, and
   * a scroll-to-dirty-page bumps `viewing-page` so the sidecar
   * kicks the daemon. Emitted at most once per compile round, AFTER
   * the round's PDF segment(s) so the FE can merge with the just-
   * shipped `shipoutPage` to compute the actual dirty frontier
   * (`max(D, shipoutPage + 1)`).
   */
  | { type: "dirty-page"; page: number };

export interface PdfSegment {
  totalLength: number;
  offset: number;
  bytes: Uint8Array;
  /**
   * 1-based supertex shipout page this segment represents — the
   * `[N.out]` index in the upstream `--daemon` protocol. Optional:
   * compilers that don't expose per-shipout structure (or don't
   * yet attach the field) leave it `undefined`, encoded on the
   * wire as the sentinel `0`. Decoders surface a positive integer
   * as `shipoutPage` and a `0` as `undefined`. Added M22.4b.
   */
  shipoutPage?: number;
  /**
   * Engine end-of-document signal: `true` when the compile round
   * observed the upstream `[pdf-end]` daemon event (the engine
   * reached `\enddocument` and emitted `%SUPERTEX-LAST-PAGE` into
   * the final chunk), `false` when the round completed without it
   * (so more pages may follow on a re-compile with a higher
   * target), `undefined` when the compiler doesn't expose the
   * signal at all. Encoded on the wire as a tri-state uint8:
   * `0` = unset, `1` = false, `2` = true. Roundtrip-safe.
   */
  lastPage?: boolean;
}

export type DecodedFrame =
  | { kind: "doc-update"; update: Uint8Array }
  | { kind: "awareness"; update: Uint8Array }
  | { kind: "control"; message: ControlMessage }
  | { kind: "pdf-segment"; segment: PdfSegment };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function encodeDocUpdate(update: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(TAG_DOC_UPDATE), update]);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(TAG_AWARENESS), update]);
}

export function encodeControl(message: ControlMessage): Uint8Array {
  return concat([Uint8Array.of(TAG_CONTROL), textEncoder.encode(JSON.stringify(message))]);
}

export function encodePdfSegment(seg: PdfSegment): Uint8Array {
  if (seg.totalLength < 0 || seg.offset < 0) {
    throw new Error("encodePdfSegment: negative length/offset");
  }
  if (seg.offset + seg.bytes.length > seg.totalLength) {
    throw new Error("encodePdfSegment: segment overruns totalLength");
  }
  const shipoutPage = seg.shipoutPage ?? 0;
  if (shipoutPage < 0 || !Number.isInteger(shipoutPage)) {
    throw new Error("encodePdfSegment: shipoutPage must be a non-negative integer");
  }
  // Tri-state encoding: undefined=0, false=1, true=2. Roundtrip-safe.
  const lastPageByte =
    seg.lastPage === undefined ? 0 : seg.lastPage ? 2 : 1;
  const header = new Uint8Array(18);
  const view = new DataView(header.buffer);
  view.setUint8(0, TAG_PDF_SEGMENT);
  view.setUint32(1, seg.totalLength, false);
  view.setUint32(5, seg.offset, false);
  view.setUint32(9, seg.bytes.length, false);
  view.setUint32(13, shipoutPage, false);
  view.setUint8(17, lastPageByte);
  return concat([header, seg.bytes]);
}

export function decodeFrame(frame: Uint8Array): DecodedFrame {
  if (frame.length < 1) throw new Error("decodeFrame: empty frame");
  const tag = frame[0]!;
  const body = frame.subarray(1);
  switch (tag) {
    case TAG_DOC_UPDATE:
      return { kind: "doc-update", update: body };
    case TAG_AWARENESS:
      return { kind: "awareness", update: body };
    case TAG_CONTROL: {
      const text = textDecoder.decode(body);
      const parsed = JSON.parse(text) as ControlMessage;
      return { kind: "control", message: parsed };
    }
    case TAG_PDF_SEGMENT: {
      if (body.length < 17) throw new Error("decodeFrame: pdf-segment header truncated");
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const totalLength = view.getUint32(0, false);
      const offset = view.getUint32(4, false);
      const segLen = view.getUint32(8, false);
      const shipoutPage = view.getUint32(12, false);
      const lastPageByte = view.getUint8(16);
      const bytes = body.subarray(17, 17 + segLen);
      if (bytes.length !== segLen) {
        throw new Error("decodeFrame: pdf-segment payload truncated");
      }
      const segment: PdfSegment = { totalLength, offset, bytes };
      if (shipoutPage > 0) segment.shipoutPage = shipoutPage;
      if (lastPageByte === 1) segment.lastPage = false;
      else if (lastPageByte === 2) segment.lastPage = true;
      else if (lastPageByte !== 0) {
        throw new Error(
          `decodeFrame: pdf-segment lastPage byte out of range (${lastPageByte})`,
        );
      }
      return { kind: "pdf-segment", segment };
    }
    default:
      throw new Error(`decodeFrame: unknown tag 0x${tag.toString(16)}`);
  }
}
