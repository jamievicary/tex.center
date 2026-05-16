// Unit test for the compile-cycle tracker (M22.4a). Validates
// that `compile-status running` resets the timer and that
// subsequent `idle` / `error` events in the same cycle carry the
// elapsed-time prefix. Other event kinds pass through unchanged.

import assert from "node:assert/strict";

const { createCompileCycleTracker } = await import(
  "../src/lib/compileCycleTracker.ts"
);

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    set(n) {
      t = n;
    },
  };
}

// Case 1: running → idle reports the elapsed delta.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(1000);
  const a = tr.observe({ kind: "compile-status", state: "running" });
  assert.equal(a.text, "compile-status running");
  c.set(4500);
  const b = tr.observe({ kind: "compile-status", state: "idle" });
  assert.equal(b.text, "3.5s — compile-status idle");
  assert.equal(b.category, "debug-orange");
  assert.equal(b.aggregateKey, "debug:compile-status:idle");
}

// Case 2: running → error reports elapsed; detail preserved.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(2000);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(2750);
  const r = tr.observe({
    kind: "compile-status",
    state: "error",
    detail: "boom",
  });
  assert.equal(r.text, "0.8s — compile-status error: boom");
}

// Case 3: cycle is reset after idle — a fresh idle without a
// preceding running gets no prefix.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(1000);
  tr.observe({ kind: "compile-status", state: "idle" });
  c.set(5000);
  const stray = tr.observe({ kind: "compile-status", state: "idle" });
  assert.equal(stray.text, "compile-status idle");
}

// Case 4: each running starts a fresh cycle (the previous cycle
// does not leak into the next).
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(2000);
  tr.observe({ kind: "compile-status", state: "idle" });
  c.set(10_000);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(10_500);
  const b = tr.observe({ kind: "compile-status", state: "idle" });
  assert.equal(b.text, "0.5s — compile-status idle");
}

// Case 5 (M22.4b + iter-374 iter-B′): pdf-segment toasts inside a
// cycle carry the elapsed-time prefix; non-prefixable events
// (outgoing-doc-update) still pass through unchanged. The segment
// format follows iter-B′: `shipoutPage>1` → `[1..N.out] <bytes>
// bytes` (the range makes the sidecar's chunks-1..N concatenation
// visible); `shipoutPage===1` → `[1.out] <bytes> bytes`; unstamped
// → `<bytes> bytes`.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(1000);
  const seg = tr.observe({
    kind: "pdf-segment",
    bytes: 1234,
    shipoutPage: 2,
  });
  assert.equal(seg.text, "1.0s — [1..2.out] 1234 bytes");
  assert.equal(seg.category, "debug-blue");
  const yjs = tr.observe({ kind: "outgoing-doc-update", bytes: 7 });
  assert.equal(yjs.text, "Yjs op 7B");
}

// Case 5b: a pdf-segment WITHOUT a preceding `running` (cycle null)
// passes through unprefixed, but still picks up the M22.4b
// `<bytes> bytes` format.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  const seg = tr.observe({ kind: "pdf-segment", bytes: 42 });
  assert.equal(seg.text, "42 bytes");
}

// Case 6: cycle survives across an intervening pdf-segment. After
// M22.4b the segment toast also carries the elapsed-time prefix —
// the cycle is not cleared by the segment (only by `idle`/`error`).
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(1700);
  const seg = tr.observe({ kind: "pdf-segment", bytes: 3652 });
  assert.equal(seg.text, "1.7s — 3652 bytes");
  c.set(4600);
  const b = tr.observe({ kind: "compile-status", state: "idle" });
  assert.equal(b.text, "4.6s — compile-status idle");
}

console.log("compileCycleTracker: OK");
