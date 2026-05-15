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

// Case 5: non-compile-status events pass through unchanged.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(1000);
  const seg = tr.observe({ kind: "pdf-segment", bytes: 1234 });
  // Today M22.4a leaves segment toasts unprefixed; M22.4b changes
  // this. Pin the current behaviour so the M22.4b change is an
  // explicit test-touching slice.
  assert.equal(seg.text, "pdf-segment 1234B");
  assert.equal(seg.category, "debug-blue");
  const yjs = tr.observe({ kind: "outgoing-doc-update", bytes: 7 });
  assert.equal(yjs.text, "Yjs op 7B");
}

// Case 6: cycle survives across an intervening pdf-segment.
{
  const c = makeClock();
  const tr = createCompileCycleTracker({ now: c.now });
  c.set(0);
  tr.observe({ kind: "compile-status", state: "running" });
  c.set(1700);
  tr.observe({ kind: "pdf-segment", bytes: 3652 });
  c.set(4600);
  const b = tr.observe({ kind: "compile-status", state: "idle" });
  assert.equal(b.text, "4.6s — compile-status idle");
}

console.log("compileCycleTracker: OK");
