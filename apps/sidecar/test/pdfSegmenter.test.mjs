// Unit tests for ShipoutSegmenter (M3.4).
//
// We don't drive a real supertex; we manipulate the shipouts file
// directly as supertex would (append-only `<page>\t<offset>` lines)
// and assert the segmenter emits the right per-shipout segments.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShipoutSegmenter, parseShipoutLines } from "../src/compiler/pdfSegmenter.ts";

// parseShipoutLines: well-formed and malformed.
{
  const ok = parseShipoutLines("1\t0\n2\t100\n3\t250\n");
  assert.deepEqual(ok, [
    { page: 1, offset: 0 },
    { page: 2, offset: 100 },
    { page: 3, offset: 250 },
  ]);
  // CR endings, blank lines, trailing whitespace, malformed lines.
  const mix = parseShipoutLines("1\t0\r\n\nbad-line\n2\t50\nnotanumber\tfoo\n");
  assert.deepEqual(mix, [
    { page: 1, offset: 0 },
    { page: 2, offset: 50 },
  ]);
  // Negative numbers and non-finite values are rejected.
  assert.deepEqual(parseShipoutLines("-1\t0\n1\t-5\n"), []);
}

const root = mkdtempSync(join(tmpdir(), "shipout-segmenter-test-"));

// Empty / missing shipouts file → fall back to one whole-PDF segment.
{
  const path = join(root, "empty-missing");
  const seg = new ShipoutSegmenter(path);
  // First call: file missing entirely.
  const out1 = await seg.update(new Uint8Array([1, 2, 3, 4]));
  assert.equal(out1.length, 1);
  assert.equal(out1[0].totalLength, 4);
  assert.equal(out1[0].offset, 0);
  assert.deepEqual(Array.from(out1[0].bytes), [1, 2, 3, 4]);
  // Second call: file still missing — still falls back.
  const out2 = await seg.update(new Uint8Array([9]));
  assert.equal(out2.length, 1);
  assert.equal(out2[0].totalLength, 1);
}

// First compile with two shipouts → two segments covering the
// whole PDF, partitioned by the offsets in the file.
{
  const path = join(root, "two-shipouts");
  writeFileSync(path, "1\t0\n2\t10\n");
  const pdf = new Uint8Array(20);
  for (let i = 0; i < pdf.length; i++) pdf[i] = i;
  const seg = new ShipoutSegmenter(path);
  const out = await seg.update(pdf);
  assert.equal(out.length, 2);
  assert.equal(out[0].offset, 0);
  assert.deepEqual(Array.from(out[0].bytes), Array.from(pdf.slice(0, 10)));
  assert.equal(out[1].offset, 10);
  assert.deepEqual(Array.from(out[1].bytes), Array.from(pdf.slice(10, 20)));
  for (const s of out) assert.equal(s.totalLength, 20);
}

// Re-compile that re-emits only the second shipout: only the second
// segment should be sent. Page 2 is re-shipped at the same offset
// (because page 1 didn't change length) but with different bytes.
{
  const path = join(root, "delta-second-only");
  writeFileSync(path, "1\t0\n2\t10\n");
  const seg = new ShipoutSegmenter(path);
  const pdf1 = new Uint8Array(20);
  for (let i = 0; i < 20; i++) pdf1[i] = i;
  const out1 = await seg.update(pdf1);
  assert.equal(out1.length, 2, "first round emits both");

  // Second round: supertex appends a new line for page 2; only it.
  appendFileSync(path, "2\t10\n");
  const pdf2 = new Uint8Array(20);
  for (let i = 0; i < 10; i++) pdf2[i] = i; // page-1 region unchanged
  for (let i = 10; i < 20; i++) pdf2[i] = 100 + i; // page-2 region changed
  const out2 = await seg.update(pdf2);
  assert.equal(out2.length, 1, "second round emits only the re-shipped page");
  assert.equal(out2[0].offset, 10);
  assert.equal(out2[0].totalLength, 20);
  assert.deepEqual(Array.from(out2[0].bytes), Array.from(pdf2.slice(10, 20)));
}

// Re-compile that grows the PDF (page 2 got longer, page 3 added).
// supertex re-emits page 2 at offset 10 (new bytes) and page 3 at
// offset 25.
{
  const path = join(root, "grow");
  writeFileSync(path, "1\t0\n2\t10\n");
  const seg = new ShipoutSegmenter(path);
  const pdf1 = new Uint8Array(20);
  await seg.update(pdf1);

  // Round 2: page 2 re-emitted larger, page 3 added.
  appendFileSync(path, "2\t10\n3\t25\n");
  const pdf2 = new Uint8Array(40);
  for (let i = 0; i < 40; i++) pdf2[i] = i & 0xff;
  const out = await seg.update(pdf2);
  assert.equal(out.length, 2, "round 2 emits page-2 and page-3");
  assert.equal(out[0].offset, 10);
  assert.deepEqual(Array.from(out[0].bytes), Array.from(pdf2.slice(10, 25)));
  assert.equal(out[1].offset, 25);
  assert.deepEqual(Array.from(out[1].bytes), Array.from(pdf2.slice(25, 40)));
  for (const s of out) assert.equal(s.totalLength, 40);
}

// Rollback / shrink: round 2 re-emits page 2 only, and the PDF is
// shorter than before (page 3 from round 1 falls past EOF). Stale
// page-3 entry must not break boundary lookup.
{
  const path = join(root, "shrink");
  writeFileSync(path, "1\t0\n2\t10\n3\t25\n");
  const seg = new ShipoutSegmenter(path);
  const pdf1 = new Uint8Array(40);
  await seg.update(pdf1);

  appendFileSync(path, "2\t10\n");
  const pdf2 = new Uint8Array(20); // pages 1+2 only
  const out = await seg.update(pdf2);
  assert.equal(out.length, 1);
  assert.equal(out[0].offset, 10);
  assert.equal(out[0].totalLength, 20);
  assert.equal(out[0].bytes.length, 10, "page-2 segment ends at EOF, not at stale page-3 offset");
}

console.log("pdf-segmenter test: OK");
