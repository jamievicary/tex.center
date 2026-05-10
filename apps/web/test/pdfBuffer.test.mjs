// Unit tests for PdfBuffer. Run via tsx so the .ts source can
// be imported directly. No DOM access; pure logic.

import assert from "node:assert/strict";
import { PdfBuffer } from "../src/lib/pdfBuffer.ts";

// Single full-buffer segment.
{
  const buf = new PdfBuffer();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const out = buf.applySegment({ totalLength: 4, offset: 0, bytes });
  assert.deepEqual(out, bytes);
  assert.equal(buf.length, 4);
}

// Append-style growth: a second segment that extends totalLength
// and writes past the previous tail.
{
  const buf = new PdfBuffer();
  buf.applySegment({ totalLength: 3, offset: 0, bytes: new Uint8Array([9, 9, 9]) });
  const out = buf.applySegment({
    totalLength: 6,
    offset: 3,
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(out, new Uint8Array([9, 9, 9, 1, 2, 3]));
}

// Patch-in-place: same total length, write a sub-range.
{
  const buf = new PdfBuffer();
  buf.applySegment({ totalLength: 5, offset: 0, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  const out = buf.applySegment({
    totalLength: 5,
    offset: 2,
    bytes: new Uint8Array([7, 7]),
  });
  assert.deepEqual(out, new Uint8Array([1, 2, 7, 7, 5]));
}

// Snapshots are independent copies (mutating one doesn't change
// the buffer or the other).
{
  const buf = new PdfBuffer();
  const a = buf.applySegment({
    totalLength: 3,
    offset: 0,
    bytes: new Uint8Array([1, 2, 3]),
  });
  a[0] = 99;
  const b = buf.snapshot();
  assert.deepEqual(b, new Uint8Array([1, 2, 3]));
}

// Overrun rejected.
{
  const buf = new PdfBuffer();
  assert.throws(() =>
    buf.applySegment({
      totalLength: 2,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    }),
  );
}

// Negative values rejected.
{
  const buf = new PdfBuffer();
  assert.throws(() =>
    buf.applySegment({
      totalLength: -1,
      offset: 0,
      bytes: new Uint8Array(),
    }),
  );
}

console.log("pdfBuffer: ok");
