// Maintains a `Uint8Array` view of an in-progress PDF as the
// sidecar streams `pdf-segment` patches. `applySegment` mutates
// the internal buffer and returns a fresh `Uint8Array` so
// callers using reference equality (Svelte $state) re-render.

import type { PdfSegment } from "@tex-center/protocol";

export class PdfBuffer {
  private buf: Uint8Array = new Uint8Array(0);

  applySegment(seg: PdfSegment): Uint8Array {
    if (seg.totalLength < 0 || seg.offset < 0) {
      throw new Error("PdfBuffer: negative length/offset");
    }
    if (seg.offset + seg.bytes.length > seg.totalLength) {
      throw new Error("PdfBuffer: segment overruns totalLength");
    }
    if (seg.totalLength !== this.buf.length) {
      const grown = new Uint8Array(seg.totalLength);
      grown.set(this.buf.subarray(0, Math.min(this.buf.length, seg.totalLength)));
      this.buf = grown;
    }
    this.buf.set(seg.bytes, seg.offset);
    return this.snapshot();
  }

  snapshot(): Uint8Array {
    const copy = new Uint8Array(this.buf.length);
    copy.set(this.buf);
    return copy;
  }

  get length(): number {
    return this.buf.length;
  }
}
