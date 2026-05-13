// Unit test for `apps/web/src/lib/editorMarks.ts`.
//
// Covers:
//  - `markOnce` records the mark on a fresh timeline.
//  - A second call with the same name is a no-op.
//  - Passing `undefined` as `perf` (no Performance API) is safe.

import assert from "node:assert/strict";

const { markOnce, EDITOR_ROUTE_MOUNTED, EDITOR_WS_OPEN } = await import(
  "../src/lib/editorMarks.ts"
);

class FakePerformance {
  constructor() {
    this.entries = [];
  }
  mark(name) {
    this.entries.push({ name, startTime: this.entries.length });
  }
  getEntriesByName(name) {
    return this.entries.filter((e) => e.name === name);
  }
}

// First call returns true and records.
{
  const perf = new FakePerformance();
  assert.equal(markOnce(EDITOR_ROUTE_MOUNTED, perf), true);
  assert.equal(perf.getEntriesByName(EDITOR_ROUTE_MOUNTED).length, 1);
}

// Second call with the same name returns false and does not duplicate.
{
  const perf = new FakePerformance();
  markOnce(EDITOR_ROUTE_MOUNTED, perf);
  assert.equal(markOnce(EDITOR_ROUTE_MOUNTED, perf), false);
  assert.equal(perf.getEntriesByName(EDITOR_ROUTE_MOUNTED).length, 1);
}

// Distinct names coexist.
{
  const perf = new FakePerformance();
  markOnce(EDITOR_ROUTE_MOUNTED, perf);
  markOnce(EDITOR_WS_OPEN, perf);
  assert.equal(perf.getEntriesByName(EDITOR_ROUTE_MOUNTED).length, 1);
  assert.equal(perf.getEntriesByName(EDITOR_WS_OPEN).length, 1);
}

// No Performance API → silent no-op, no throw. Simulate the
// SSR/test environment by stubbing the global out for one call,
// since JS default parameters only fire for `undefined` and the
// real Node `performance` would otherwise satisfy the default.
{
  const original = globalThis.performance;
  // @ts-ignore — deliberate removal to exercise the absent-API branch.
  delete globalThis.performance;
  try {
    assert.equal(markOnce(EDITOR_ROUTE_MOUNTED), false);
  } finally {
    globalThis.performance = original;
  }
}

console.log("editorMarks.test.mjs OK");
