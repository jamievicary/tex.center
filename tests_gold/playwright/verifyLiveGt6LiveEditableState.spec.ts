// GT-6-live-editable — M13.2(b).3.
//
// The existing `verifyLiveGt6FastContentAppearance` spec asserts the
// M13.2(a) SSR seed gate: a fresh project (no `machine_assignments`
// row, no per-project Machine yet) shows the seeded `.tex` source
// inside `.editor` within 500 ms of route-interactive. That covers
// the visual-only seed `<pre>` placeholder; it does NOT assert the
// editor is actually editable (Yjs connected, CodeMirror bound).
//
// M13.2(b) is the harder target: on a project whose per-project
// Machine has been SUSPENDED (M13.2(b).1 wired iter 249 + iter 255),
// clicking the dashboard link should bring the editor to a
// fully-live state within ~1000 ms — i.e. `.cm-content` populated
// AND a keystroke produces a Yjs DOC_UPDATE wire frame within
// 1000 ms of the keypress.
//
// Approach:
//   1. Create a fresh project. Navigate `/editor/<id>` to spawn the
//      per-project Machine and let cold-start complete (first
//      pdf-segment seen on WS). This puts the Machine in the
//      `started` state with a hydrated Y.Doc.
//   2. Leave the editor (go to `/projects`) to close the WS.
//   3. Force-suspend the Machine via the Fly Machines API
//      (`POST /machines/{id}/suspend`). This is the same endpoint
//      the sidecar's own idle handler calls; bypassing the 10-min
//      idle timer lets us drive the suspended-resume path in a few
//      seconds rather than ten minutes. Poll `GET /machines/{id}`
//      until `state === "suspended"` (bounded).
//   4. From `/projects`, click the project link. Measure:
//        - `cmContentReadyMs` — from click → `.cm-content` contains
//          the seeded `documentclass` sentinel.
//        - `keystrokeAckMs` — from `keyboard.type(...)` → next
//          `framesent` of a Yjs DOC_UPDATE (tag 0x00) on the WS.
//      Both must be ≤ 1000 ms.
//
// Aspirational. Gold-only — failures don't revert. Per `PLAN.md`,
// the known follow-up is widening the SSR seed source to serve
// the persisted blob for non-fresh projects; until that lands this
// spec is expected to go RED on the `cmContentReadyMs` budget
// (currently ~11.5 s per `logs/236.md` and PLAN §M13.2(b) known
// follow-ups).
//
// Test body lives in `./fixtures/coldFromInactiveLiveEditableTest.ts`,
// shared with the M13.2(b).4 `Stopped` variant.

import { test } from "./fixtures/authedPage.js";
import { runColdFromInactiveLiveEditableTest } from "./fixtures/coldFromInactiveLiveEditableTest.js";

// Maximum wait for Fly to transition the Machine into `suspended`
// after the suspend API call. Empirically Fly settles within a few
// seconds; this is the outer bound before we give up.
const SUSPEND_SETTLE_TIMEOUT_MS = 60_000;

test.describe("live cold-from-suspended editable state (M13.2(b).3)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6LiveEditableState runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
    test.skip(
      (process.env.FLY_API_TOKEN ?? "") === "",
      "FLY_API_TOKEN required to drive Fly suspend API",
    );
  });

  test("suspended project: dashboard click → `.cm-content` populated and keystroke acked within 1000 ms each", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Budget: 1.5× observed (iter 302: 23.6 s). Regression-guard, not
    // a generic safety net — a real perf hit on cold-start + suspend
    // cycle will trip this before the diagnostic assertions below.
    testInfo.setTimeout(40_000);

    await runColdFromInactiveLiveEditableTest(
      {
        label: "verifyLiveGt6LiveEditableState",
        flyAction: "suspend",
        flyState: "suspended",
        settleTimeoutMs: SUSPEND_SETTLE_TIMEOUT_MS,
        projectNamePrefix: "pw-gt6-live",
      },
      { authedPage, db, testInfo },
    );
  });
});

