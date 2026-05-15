// Unit tests for pageTracker. No DOM; pure logic over visibility
// ratios.

import assert from "node:assert/strict";
import {
  PageTracker,
  pickMaxVisible,
  pickMostVisible,
} from "../src/lib/pageTracker.ts";

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

// pickMaxVisible: highest page with any non-zero ratio wins; ratio
// magnitude is irrelevant beyond the "> 0" predicate.
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.9 },
    { page: 2, ratio: 0.05 },
    { page: 3, ratio: 0.0 },
  ]),
  2,
);
assert.equal(
  pickMaxVisible([
    { page: 1, ratio: 0.0 },
    { page: 2, ratio: 0.4 },
    { page: 5, ratio: 0.01 },
  ]),
  5,
);
assert.equal(pickMaxVisible([{ page: 1, ratio: 0 }]), null);
assert.equal(pickMaxVisible([]), null);

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
