// Unit tests for pdfRenderScale (M18). The function is pure; we
// pin the DPR fallback behaviour because the renderer can't recover
// if a browser reports something silly here.

import assert from "node:assert/strict";
import { pdfRenderScale } from "../src/lib/pdfRenderScale.ts";

// DPR=1: pixel scale matches CSS scale.
{
  const r = pdfRenderScale(1.5, 1);
  assert.equal(r.cssScale, 1.5);
  assert.equal(r.pixelScale, 1.5);
}

// DPR=2 (retina): pixel scale doubles.
{
  const r = pdfRenderScale(1.5, 2);
  assert.equal(r.cssScale, 1.5);
  assert.equal(r.pixelScale, 3);
}

// Fractional DPR is preserved.
{
  const r = pdfRenderScale(1.5, 1.25);
  assert.equal(r.cssScale, 1.5);
  assert.equal(r.pixelScale, 1.875);
}

// DPR=0 falls back to 1 (some headless contexts report 0).
{
  const r = pdfRenderScale(1.5, 0);
  assert.equal(r.pixelScale, 1.5);
}

// Negative DPR falls back to 1.
{
  const r = pdfRenderScale(1.5, -2);
  assert.equal(r.pixelScale, 1.5);
}

// NaN DPR falls back to 1.
{
  const r = pdfRenderScale(1.5, Number.NaN);
  assert.equal(r.pixelScale, 1.5);
}

// Infinity DPR falls back to 1 (`Number.isFinite` filters it).
{
  const r = pdfRenderScale(1.5, Number.POSITIVE_INFINITY);
  assert.equal(r.pixelScale, 1.5);
}

// Base scale is faithfully reflected even at unusual sizes.
{
  const r = pdfRenderScale(0.5, 2);
  assert.equal(r.cssScale, 0.5);
  assert.equal(r.pixelScale, 1);
}

console.log("pdfRenderScale.test.mjs: PASS");
