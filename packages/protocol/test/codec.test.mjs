// Round-trip tests for the wire codec. Pure JS so no transpiler is
// needed; we import the TypeScript source via tsx (invoked by the
// runner). Asserts use node:assert/strict.

import assert from "node:assert/strict";
import {
  MAIN_DOC_NAME,
  PROTOCOL_VERSION,
  TAG_DOC_UPDATE,
  TAG_CONTROL,
  TAG_PDF_SEGMENT,
  decodeFrame,
  encodeControl,
  encodeDocUpdate,
  encodePdfSegment,
} from "../src/index.ts";

assert.equal(PROTOCOL_VERSION, 1);
assert.equal(MAIN_DOC_NAME, "main.tex");

// doc-update round-trip
{
  const update = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeDocUpdate(update);
  assert.equal(frame[0], TAG_DOC_UPDATE);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "doc-update");
  assert.deepEqual(Array.from(decoded.update), [1, 2, 3, 4, 5]);
}

// control message round-trip
{
  const frame = encodeControl({ type: "view", page: 7 });
  assert.equal(frame[0], TAG_CONTROL);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "control");
  assert.deepEqual(decoded.message, { type: "view", page: 7 });
}

// pdf-segment round-trip
{
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  const frame = encodePdfSegment({ totalLength: 4, offset: 0, bytes });
  assert.equal(frame[0], TAG_PDF_SEGMENT);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "pdf-segment");
  assert.equal(decoded.segment.totalLength, 4);
  assert.equal(decoded.segment.offset, 0);
  assert.deepEqual(Array.from(decoded.segment.bytes), [0x25, 0x50, 0x44, 0x46]);
}

// pdf-segment overrun rejection
{
  assert.throws(() =>
    encodePdfSegment({
      totalLength: 2,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    }),
  );
}

// unknown tag rejection
{
  assert.throws(() => decodeFrame(new Uint8Array([0xff, 0, 0])));
}

console.log("protocol codec tests: OK");
