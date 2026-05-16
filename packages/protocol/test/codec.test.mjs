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
  validateProjectFileName,
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

// file-list control message round-trip
{
  const frame = encodeControl({ type: "file-list", files: ["main.tex", "refs.bib"] });
  assert.equal(frame[0], TAG_CONTROL);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "control");
  assert.deepEqual(decoded.message, { type: "file-list", files: ["main.tex", "refs.bib"] });
}

// pdf-segment round-trip (iter-A pdf-end slice: 18-byte header
// including tag, shipoutPage omitted ⇒ wire sentinel 0 ⇒ decoded
// `shipoutPage` stays undefined; lastPage omitted ⇒ wire byte 0 ⇒
// decoded `lastPage` stays undefined).
{
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  const frame = encodePdfSegment({ totalLength: 4, offset: 0, bytes });
  assert.equal(frame[0], TAG_PDF_SEGMENT);
  assert.equal(frame.length, 18 + bytes.length, "header is 18 bytes incl. tag");
  // shipoutPage sentinel (bytes 13..16 of the frame) is 0.
  const shipoutWord =
    (frame[13] << 24) | (frame[14] << 16) | (frame[15] << 8) | frame[16];
  assert.equal(shipoutWord, 0);
  // lastPage byte (frame[17]) is 0 = unset.
  assert.equal(frame[17], 0);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "pdf-segment");
  assert.equal(decoded.segment.totalLength, 4);
  assert.equal(decoded.segment.offset, 0);
  assert.deepEqual(Array.from(decoded.segment.bytes), [0x25, 0x50, 0x44, 0x46]);
  assert.equal(decoded.segment.shipoutPage, undefined);
  assert.equal(decoded.segment.lastPage, undefined);
}

// pdf-segment round-trip with shipoutPage stamped.
{
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  const frame = encodePdfSegment({
    totalLength: 4,
    offset: 0,
    bytes,
    shipoutPage: 7,
  });
  assert.equal(frame.length, 18 + bytes.length);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "pdf-segment");
  assert.equal(decoded.segment.shipoutPage, 7);
  assert.equal(decoded.segment.lastPage, undefined);
}

// pdf-segment round-trip with lastPage=true (engine reached
// \enddocument; wire byte 2).
{
  const bytes = new Uint8Array([1, 2]);
  const frame = encodePdfSegment({
    totalLength: 2,
    offset: 0,
    bytes,
    shipoutPage: 5,
    lastPage: true,
  });
  assert.equal(frame.length, 18 + bytes.length);
  assert.equal(frame[17], 2, "lastPage=true encoded as byte 2");
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "pdf-segment");
  assert.equal(decoded.segment.shipoutPage, 5);
  assert.equal(decoded.segment.lastPage, true);
}

// pdf-segment round-trip with lastPage=false (compiler observed
// the round end without [pdf-end]; more pages may follow). Wire
// byte 1 — distinguishable from "unset" (byte 0).
{
  const bytes = new Uint8Array([9]);
  const frame = encodePdfSegment({
    totalLength: 1,
    offset: 0,
    bytes,
    shipoutPage: 2,
    lastPage: false,
  });
  assert.equal(frame[17], 1, "lastPage=false encoded as byte 1");
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "pdf-segment");
  assert.equal(decoded.segment.lastPage, false);
}

// pdf-segment header-truncation rejection — body must be ≥ 17
// bytes (16 for the four u32 fields + 1 for the lastPage byte).
{
  // Old-shape 13-byte header (tag + three u32s, no shipoutPage / no
  // lastPage) is rejected — predates M22.4b.
  const oldShape = new Uint8Array(13);
  oldShape[0] = TAG_PDF_SEGMENT;
  assert.throws(() => decodeFrame(oldShape), /header truncated/);
  // M22.4b-shape 17-byte header (no lastPage byte) is rejected
  // after iter-A widening; sidecar/web must redeploy together.
  const m22shape = new Uint8Array(17);
  m22shape[0] = TAG_PDF_SEGMENT;
  assert.throws(() => decodeFrame(m22shape), /header truncated/);
}

// pdf-segment lastPage byte out-of-range rejection. Wire values 3+
// are reserved and must fail decode rather than silently mapping to
// true/false — a forward-incompat sidecar should not be misread by
// the FE.
{
  const bytes = new Uint8Array([0]);
  const frame = encodePdfSegment({
    totalLength: 1,
    offset: 0,
    bytes,
  });
  // Mutate the lastPage byte to an unrecognised value.
  const tampered = new Uint8Array(frame);
  tampered[17] = 7;
  assert.throws(() => decodeFrame(tampered), /lastPage byte out of range/);
}

// shipoutPage validation — negative / non-integer / undefined.
{
  const bytes = new Uint8Array([1]);
  assert.throws(() =>
    encodePdfSegment({ totalLength: 1, offset: 0, bytes, shipoutPage: -1 }),
  );
  assert.throws(() =>
    encodePdfSegment({ totalLength: 1, offset: 0, bytes, shipoutPage: 1.5 }),
  );
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

// validateProjectFileName: shared client/server rule.
{
  // Accepted shapes — single-segment names plus `/`-separated
  // multi-segment paths (M11.1b: virtual folder prerequisite).
  for (const ok of [
    "main.tex",
    "refs.bib",
    "appendix-A.tex",
    "Notes_1.tex",
    "a",
    "chapters/intro.tex",
    "chapters/sub/deep.tex",
    "a/b/c/d/e.tex",
  ]) {
    assert.equal(validateProjectFileName(ok), null, `expected accept: ${ok}`);
  }
  // Reject reasons (string, non-empty). Spot-check each branch.
  assert.equal(validateProjectFileName(""), "empty name");
  assert.equal(validateProjectFileName("."), "reserved segment");
  assert.equal(validateProjectFileName(".."), "reserved segment");
  assert.equal(validateProjectFileName("a/."), "reserved segment");
  assert.equal(validateProjectFileName("a/../b"), "reserved segment");
  assert.equal(validateProjectFileName("/a"), "name must not start or end with '/'");
  assert.equal(validateProjectFileName("a/"), "name must not start or end with '/'");
  assert.equal(validateProjectFileName("a//b"), "empty segment");
  assert.equal(validateProjectFileName("with space.tex"), "name has disallowed characters");
  assert.equal(
    validateProjectFileName("ok/with space.tex"),
    "name has disallowed characters",
  );
  assert.equal(validateProjectFileName("emoji-🚀.tex"), "name has disallowed characters");
  assert.equal(validateProjectFileName("a".repeat(129)), "name too long");
}

// file-op-error control message round-trip
{
  for (const op of ["create-file", "delete-file", "rename-file", "upload-file"]) {
    const frame = encodeControl({ type: "file-op-error", op, reason: "already exists" });
    const decoded = decodeFrame(frame);
    assert.equal(decoded.kind, "control");
    assert.deepEqual(decoded.message, {
      type: "file-op-error",
      op,
      reason: "already exists",
    });
  }
}

// upload-file control message round-trip
{
  const frame = encodeControl({
    type: "upload-file",
    name: "refs.bib",
    content: "@book{x,title={Y}}\n",
  });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, "control");
  assert.deepEqual(decoded.message, {
    type: "upload-file",
    name: "refs.bib",
    content: "@book{x,title={Y}}\n",
  });
}

console.log("protocol codec tests: OK");
