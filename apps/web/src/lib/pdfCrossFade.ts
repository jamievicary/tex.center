// Cross-fade blend strategy for the PDF preview pane (M17.b).
//
// Two canvases (`leaving`, `entering`) cohabit a wrapper while a
// page transitions between commits. The visible-pixel composite is
// determined entirely by which canvas is on top of the stacking
// order and how their opacities animate.
//
// **Previous (naïve) layering.** Entering canvas on top fading
// 0→1, leaving below fading 1→0. The "below" canvas's contribution
// drops as `(1−T)` of its own alpha _plus_ another `(1−T)` of the
// "above" canvas's transmittance, giving
//
//   `result = T·NEW + (1−T)²·OLD + T·(1−T)·BG`.
//
// For a flat-grey panel where `OLD == NEW == G ≠ BG` this dips
// toward `BG` at `T = 0.5` (visible flicker / background bleed).
//
// **Current strategy (this module).** Entering canvas _below_ at
// opacity 1 (constant); leaving canvas _above_ fading 1→0. The
// entering layer fully covers the background; the leaving layer
// blends linearly on top:
//
//   `result = (1−T)·OLD + T·NEW`.
//
// For `OLD == NEW` this is flat in `T` regardless of `BG`. No
// bleed, no dim, no flicker.

export interface CrossFadeStrategy {
  /** Opacity of the entering canvas throughout the fade. */
  readonly enteringOpacity: number;
  /** Opacity of the leaving canvas at `t = 0`. */
  readonly leavingInitialOpacity: number;
  /** Opacity of the leaving canvas at `t = 1`. */
  readonly leavingTargetOpacity: number;
  /**
   * z-index of each layer. Higher = on top. Both layers are
   * absolutely positioned in the wrapper, so DOM order would also
   * work — we use explicit z-index to keep the contract independent
   * of insertion order.
   */
  readonly enteringZIndex: number;
  readonly leavingZIndex: number;
}

export const CROSS_FADE_STRATEGY: CrossFadeStrategy = {
  enteringOpacity: 1,
  leavingInitialOpacity: 1,
  leavingTargetOpacity: 0,
  enteringZIndex: 0,
  leavingZIndex: 1,
};

/**
 * `source-over` composite of `top` (alpha `topA`) over `bottom`,
 * single colour channel. `topA` is clamped to `[0, 1]`.
 */
export function composeOver(top: number, topA: number, bottom: number): number {
  const a = topA < 0 ? 0 : topA > 1 ? 1 : topA;
  return a * top + (1 - a) * bottom;
}

/**
 * Visible single-channel pixel value at fade progress `t` for the
 * given old/new/background channel values, under `strategy`. Used
 * by tests to assert the flat-grey invariant.
 */
export function crossFadeAt(
  t: number,
  oldVal: number,
  newVal: number,
  bg: number,
  strategy: CrossFadeStrategy = CROSS_FADE_STRATEGY,
): number {
  const enterA = strategy.enteringOpacity;
  const leaveA =
    strategy.leavingInitialOpacity +
    t * (strategy.leavingTargetOpacity - strategy.leavingInitialOpacity);
  const enterUnder = strategy.enteringZIndex < strategy.leavingZIndex;
  if (enterUnder) {
    // bg → enter → leave
    const afterEnter = composeOver(newVal, enterA, bg);
    return composeOver(oldVal, leaveA, afterEnter);
  }
  // bg → leave → enter
  const afterLeave = composeOver(oldVal, leaveA, bg);
  return composeOver(newVal, enterA, afterLeave);
}
