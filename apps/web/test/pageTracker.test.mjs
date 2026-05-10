// Unit tests for pageTracker. No DOM; pure logic over visibility
// ratios.

import assert from "node:assert/strict";
import { PageTracker, pickMostVisible } from "../src/lib/pageTracker.ts";

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

// PageTracker reports only on transition.
{
  const t = new PageTracker();
  assert.equal(t.update(1, 1.0), 1);
  // Same page still most-visible: no transition.
  assert.equal(t.update(1, 0.9), null);
  // Page 2 takes over.
  assert.equal(t.update(2, 1.0), 2);
  // Drop page 2 visibility; page 1 still has 0.9 from earlier.
  assert.equal(t.update(2, 0.0), 1);
  // Reset clears state.
  t.reset();
  assert.equal(t.visible, null);
  assert.equal(t.update(3, 0.5), 3);
}

// Page off-screen entirely (ratio 0 from the start) is never reported.
{
  const t = new PageTracker();
  assert.equal(t.update(1, 0.0), null);
  assert.equal(t.update(2, 0.0), null);
}

console.log("pageTracker: ok");
