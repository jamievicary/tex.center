// Unit tests for pageTracker. No DOM; pure logic over visibility
// ratios.

import assert from "node:assert/strict";
import {
  MAX_VISIBLE_RATIO_THRESHOLD,
  PageTracker,
  pickMaxVisible,
  pickMostVisible,
} from "../src/lib/pageTracker.ts";

// Load-bearing default: a 1-pixel sliver of a higher page must not
// promote max-visible to that page (M21.3a). 0.1 = at least 10% of
// the page area is in the viewport.
assert.equal(MAX_VISIBLE_RATIO_THRESHOLD, 0.1);

// pickMostVisible: highest ratio wins.
assert.equal(
  pickMostVisible([
    { page: 1, ratio: 0.2 },
    { page: 2, ratio: 0.8 },
    { page: 3, ratio: 0.0 },
  ]),
  2,
);

// Tie on ratio: lower page wins.
assert.equal(
  pickMostVisible([
    { page: 5, ratio: 0.5 },
    { page: 3, ratio: 0.5 },
    { page: 4, ratio: 0.5 },
  ]),
  3,
);

// Nothing visible → null.
assert.equal(pickMostVisible([{ page: 1, ratio: 0 }]), null);
assert.equal(pickMostVisible([]), null);

// pickMaxVisible: highest page whose ratio exceeds the default
// threshold (0.1) wins; ratio magnitude beyond the predicate is
// irrelevant. Slivers below the threshold are ignored.
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.9 },
    { page: 2, ratio: 0.4 },
    { page: 3, ratio: 0.0 },
  ]),
  2,
);
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.0 },
    { page: 2, ratio: 0.4 },
    { page: 5, ratio: 0.6 },
  ]),
  5,
);
assert.equal(pickMaxVisible([{ page: 1, ratio: 0 }]), null);
assert.equal(pickMaxVisible([]), null);

// Sliver suppression: a 5% intrusion of page 2 must not promote
// max-visible to 2 — the user-reported off-by-one fix (M21.3a).
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.9 },
    { page: 2, ratio: 0.05 },
  ]),
  1,
);
// Sliver-only frame yields null even with a fully-visible-looking
// ratio below threshold.
assert.equal(
  pickMaxVisible([
    { page: 3, ratio: 0.08 },
    { page: 4, ratio: 0.02 },
  ]),
  null,
);
// Boundary: ratio exactly equal to threshold doesn't count (strict
// `>` predicate). Page 1 with 0.5 wins over page 2 sitting on the
// 0.1 line.
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.5 },
    { page: 2, ratio: MAX_VISIBLE_RATIO_THRESHOLD },
  ]),
  1,
);
// Explicit threshold override: zero recovers the prior strict-`>0`
// behaviour, useful for callers that genuinely want any-pixel
// semantics.
assert.equal(
  pickMaxVisible(
    [
      { page: 1, ratio: 0.9 },
      { page: 2, ratio: 0.05 },
    ],
    0,
  ),
  2,
);
// Custom threshold: 0.5 demands at least half the page in viewport.
assert.equal(
  pickMaxVisible(
    [
      { page: 1, ratio: 0.9 },
      { page: 2, ratio: 0.4 },
    ],
    0.5,
  ),
  1,
);

// PageTracker.update returns transitions for both most- and
// max-visible. A member is non-null iff that value changed.
{
  const t = new PageTracker();
  // First sighting: page 1 most- and max-visible.
  assert.deepEqual(t.update(1, 1.0), { mostVisible: 1, maxVisible: 1 });
  assert.equal(t.mostVisible, 1);
  assert.equal(t.maxVisible, 1);
  // Same page, lower ratio: no transition either way.
  assert.deepEqual(t.update(1, 0.9), { mostVisible: null, maxVisible: null });
  // Page 2 enters at 0.4: max-visible flips to 2, most-visible
  // stays 1 (0.9 > 0.4).
  assert.deepEqual(t.update(2, 0.4), { mostVisible: null, maxVisible: 2 });
  assert.equal(t.mostVisible, 1);
  assert.equal(t.maxVisible, 2);
  // Page 2 ratio climbs above page 1: most-visible flips to 2,
  // max-visible already 2 → null.
  assert.deepEqual(t.update(2, 0.95), { mostVisible: 2, maxVisible: null });
  // Page 2 drops to 0: max-visible falls back to page 1 (still 0.9),
  // and most-visible follows.
  assert.deepEqual(t.update(2, 0.0), { mostVisible: 1, maxVisible: 1 });
  assert.equal(t.mostVisible, 1);
  assert.equal(t.maxVisible, 1);
}

// Tracker honours the max-visible threshold: a sliver intrusion
// below 0.1 does not flip maxVisible (M21.3a). pickMostVisible
// still tracks the sliver page as least-dominant since its
// strict-`>0` predicate is unchanged.
{
  const t = new PageTracker();
  t.update(1, 0.9);
  assert.equal(t.maxVisible, 1);
  // Page 2 enters as a 5% sliver — below threshold, max-visible
  // must stay at 1, and no transition is reported.
  assert.deepEqual(t.update(2, 0.05), { mostVisible: null, maxVisible: null });
  assert.equal(t.maxVisible, 1);
  // Once page 2 climbs above the threshold, max-visible flips.
  assert.deepEqual(t.update(2, 0.4), { mostVisible: null, maxVisible: 2 });
  assert.equal(t.maxVisible, 2);
  // Page 2 retreats to a sliver again: max-visible falls back to
  // page 1 (still 0.9, above threshold).
  assert.deepEqual(t.update(2, 0.05), { mostVisible: null, maxVisible: 1 });
}

// Tracker preserves last-known when an update would leave the map
// empty of visible pages — no transition is emitted in that case.
{
  const t = new PageTracker();
  t.update(1, 1.0);
  // Drop the only visible page to zero. Both current values stay
  // at their last non-null state; no transitions reported.
  assert.deepEqual(t.update(1, 0.0), { mostVisible: null, maxVisible: null });
  assert.equal(t.mostVisible, 1);
  assert.equal(t.maxVisible, 1);
}

// Reset clears both axes.
{
  const t = new PageTracker();
  t.update(1, 0.5);
  t.update(2, 0.8);
  t.reset();
  assert.equal(t.mostVisible, null);
  assert.equal(t.maxVisible, null);
  assert.equal(t.visible, null);
  assert.deepEqual(t.update(3, 0.5), { mostVisible: 3, maxVisible: 3 });
}

// Pages off-screen entirely (ratio 0 from the start) are never
// reported, on either axis.
{
  const t = new PageTracker();
  assert.deepEqual(t.update(1, 0.0), { mostVisible: null, maxVisible: null });
  assert.deepEqual(t.update(2, 0.0), { mostVisible: null, maxVisible: null });
}

// Back-compat: `visible` getter still reflects most-visible.
{
  const t = new PageTracker();
  t.update(1, 0.5);
  t.update(2, 0.9);
  assert.equal(t.visible, 2);
}

console.log("pageTracker: ok");
