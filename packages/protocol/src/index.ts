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
//   bytes              — raw PDF bytes for this segment.

export const PROTOCOL_VERSION = 1;

// The Yjs Y.Text key both sides agree on for the project's primary
// `.tex` source. Single-file MVP; M4 generalises to one Y.Text per
// file in the project tree, keyed by filename.
export const MAIN_DOC_NAME = "main.tex";

// Allowed characters for a project-relative file name. Single
// segment (no `/`), reasonably URL-safe, no whitespace. The sidecar
// is the authority here (defence-in-depth); the rule lives in the
// shared protocol package so the web client can mirror it and
// surface validation errors immediately on the create/rename
// affordances rather than relying on a silent server-side reject.
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const FILE_NAME_MAX_LEN = 128;

/**
 * Validate a project-relative filename. Returns a short
 * human-readable reason when invalid, otherwise `null`.
 */
export function validateProjectFileName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "empty name";
  if (name.length > FILE_NAME_MAX_LEN) return "name too long";
  if (name === "." || name === "..") return "reserved name";
  if (name.includes("/")) return "name must not contain '/'";
  if (!FILE_NAME_RE.test(name)) return "name has disallowed characters";
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
  | {
      type: "file-op-error";
      op: "create-file" | "delete-file" | "rename-file";
      reason: string;
    };

export interface PdfSegment {
  totalLength: number;
  offset: number;
  bytes: Uint8Array;
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
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint8(0, TAG_PDF_SEGMENT);
  view.setUint32(1, seg.totalLength, false);
  view.setUint32(5, seg.offset, false);
  view.setUint32(9, seg.bytes.length, false);
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
      if (body.length < 12) throw new Error("decodeFrame: pdf-segment header truncated");
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const totalLength = view.getUint32(0, false);
      const offset = view.getUint32(4, false);
      const segLen = view.getUint32(8, false);
      const bytes = body.subarray(12, 12 + segLen);
      if (bytes.length !== segLen) {
        throw new Error("decodeFrame: pdf-segment payload truncated");
      }
      return { kind: "pdf-segment", segment: { totalLength, offset, bytes } };
    }
    default:
      throw new Error(`decodeFrame: unknown tag 0x${tag.toString(16)}`);
  }
}
