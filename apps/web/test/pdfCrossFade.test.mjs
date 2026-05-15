// Unit tests for the M17.b cross-fade blend strategy.
//
// Two properties drive the assertions:
//
//   1. **Flat-grey invariant.** When `OLD == NEW`, the visible pixel
//      is constant in `t` regardless of background — no mid-fade
//      bleed-through.
//   2. **Linear interpolation.** For `OLD ≠ NEW`, the visible pixel
//      is `(1 − t)·OLD + t·NEW` at every `t`. Background never
//      enters the result.
//
// A `LEGACY_STRATEGY` is included as a regression guard: under the
// old layering (entering on top fading 0→1, leaving below fading
// 1→0) both invariants fail, so flipping to it should make the
// asserts fail. This is checked once explicitly.

import assert from "node:assert/strict";
import {
  CROSS_FADE_STRATEGY,
  composeOver,
  crossFadeAt,
} from "../src/lib/pdfCrossFade.ts";

const LEGACY_STRATEGY = {
  enteringOpacity: 1, // ignored at t = 0; entering fades 0→1 here
  leavingInitialOpacity: 1,
  leavingTargetOpacity: 0,
  enteringZIndex: 1,
  leavingZIndex: 0,
};

// `crossFadeAt` doesn't model entering-also-fading; for the legacy
// regression we model entering opacity explicitly via composeOver.
function legacyAt(t, oldVal, newVal, bg) {
  // entering on top: alpha = t. leaving below: alpha = 1 − t.
  const afterLeave = composeOver(oldVal, 1 - t, bg);
  return composeOver(newVal, t, afterLeave);
}

const SAMPLES = [0, 0.01, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.99, 1];
const EPS = 1e-12;

// --- Test 1: composeOver basics. ---
{
  assert.equal(composeOver(255, 1, 0), 255);
  assert.equal(composeOver(255, 0, 0), 0);
  assert.equal(composeOver(255, 0.5, 0), 127.5);
  // Out-of-range alpha clamps.
  assert.equal(composeOver(255, -1, 0), 0);
  assert.equal(composeOver(255, 2, 0), 255);
}

// --- Test 2: flat-grey invariant. OLD == NEW, vary BG. ---
//
// Strongest form of the M17.b fix: even with a wildly different
// background (white panel on black, or vice versa), the visible
// pixel never drifts from the panel colour.
{
  const cases = [
    { g: 200, bg: 0 },
    { g: 200, bg: 255 },
    { g: 50, bg: 255 },
    { g: 128, bg: 200 },
    { g: 0, bg: 255 },
  ];
  for (const { g, bg } of cases) {
    for (const t of SAMPLES) {
      const v = crossFadeAt(t, g, g, bg);
      assert.ok(
        Math.abs(v - g) < EPS,
        `flat-grey violated: t=${t} g=${g} bg=${bg} got ${v}`,
      );
    }
  }
}

// --- Test 3: linear interpolation OLD → NEW, BG irrelevant. ---
{
  const cases = [
    { oldVal: 0, newVal: 255, bg: 128 },
    { oldVal: 50, newVal: 200, bg: 0 },
    { oldVal: 200, newVal: 50, bg: 255 },
    { oldVal: 100, newVal: 100, bg: 1 }, // degenerate: same as flat-grey
  ];
  for (const { oldVal, newVal, bg } of cases) {
    for (const t of SAMPLES) {
      const expected = (1 - t) * oldVal + t * newVal;
      const got = crossFadeAt(t, oldVal, newVal, bg);
      assert.ok(
        Math.abs(got - expected) < 1e-10,
        `lerp violated: t=${t} old=${oldVal} new=${newVal} bg=${bg} ` +
          `expected ${expected} got ${got}`,
      );
    }
  }
}

// --- Test 4: endpoint sanity. t=0 → OLD, t=1 → NEW. ---
{
  assert.equal(crossFadeAt(0, 50, 200, 0), 50);
  assert.equal(crossFadeAt(1, 50, 200, 0), 200);
  assert.equal(crossFadeAt(0, 50, 200, 255), 50);
  assert.equal(crossFadeAt(1, 50, 200, 255), 200);
}

// --- Test 5: strategy contract — the constants the DOM adapter relies on. ---
{
  assert.equal(CROSS_FADE_STRATEGY.enteringOpacity, 1);
  assert.equal(CROSS_FADE_STRATEGY.leavingInitialOpacity, 1);
  assert.equal(CROSS_FADE_STRATEGY.leavingTargetOpacity, 0);
  // Entering must be below leaving for the math to come out right.
  assert.ok(
    CROSS_FADE_STRATEGY.enteringZIndex < CROSS_FADE_STRATEGY.leavingZIndex,
    "entering must be below leaving in stacking order",
  );
}

// --- Test 6: legacy strategy fails the flat-grey property. ---
//
// Regression guard: if a future refactor reverts the strategy, the
// asserts in Test 2 catch it; this test confirms those asserts
// would fail under the legacy layering.
{
  const bg = 0;
  const g = 200;
  const t = 0.5;
  const v = legacyAt(t, g, g, bg);
  // legacy: t·G + (1−t)²·G + t·(1−t)·bg = 0.5·200 + 0.25·200 + 0 = 150
  assert.ok(Math.abs(v - 150) < 1e-10, `legacy math sanity: got ${v}`);
  // And in particular, v ≠ g — the failure mode the M17.b fix kills.
  assert.notEqual(Math.round(v), g);
}

console.log("pdfCrossFade: ok");
