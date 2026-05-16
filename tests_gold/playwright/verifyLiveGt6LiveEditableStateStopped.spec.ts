// GT-6-live-editable-stopped — M13.2(b).4.
//
// Sibling of `verifyLiveGt6LiveEditableState.spec.ts`. That spec
// drives the per-project Machine into `suspended` via Fly's
// `POST /machines/{id}/suspend`, which exercises the optimistic
// resume path: memory remains mapped on the host so the runtime
// returns in a few hundred ms.
//
// M13.2(b).4 pins the harder path: the sidecar idle-handler
// fallback (`process.exit(0)` after MAX_IDLE_MS) lands a Machine
// in `stopped`, not `suspended`. That path was reported by the
// user as taking 20 s+ on cold-load (see `260_answer.md`). This
// spec drives the same state machine — but via `POST
// /machines/{id}/stop`, polls until `state === "stopped"`,
// clicks the dashboard link, and asserts the same 1000 ms
// `.cm-content`-ready / 1000 ms keystroke-ack budget as
// M13.2(b).3.
//
// Aspirational. Gold-only — failures don't revert. Expected RED
// on landing; the fix is M13.2(b).5 (PLAN: either widen SSR seed
// for non-fresh projects, or eliminate `stopped` as a reachable
// per-project state).
//
// Test body lives in `./fixtures/coldFromInactiveLiveEditableTest.ts`,
// shared with the M13.2(b).3 `Suspended` variant.

import { test } from "./fixtures/authedPage.js";
import { runColdFromInactiveLiveEditableTest } from "./fixtures/coldFromInactiveLiveEditableTest.js";

// Stop is slower than suspend on Fly because the runtime is fully
// torn down (no mapped-memory shortcut). Empirically completes
// within a few seconds; 120 s is a generous outer bound.
const STOP_SETTLE_TIMEOUT_MS = 120_000;

test.describe("live cold-from-stopped editable state (M13.2(b).4)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6LiveEditableStateStopped runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
    test.skip(
      (process.env.FLY_API_TOKEN ?? "") === "",
      "FLY_API_TOKEN required to drive Fly stop API",
    );
  });

  test("stopped project: dashboard click → `.cm-content` populated and keystroke acked within 1000 ms each", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Outer wall-clock budget. The real product invariants
    // (`cmContentReadyMs` ≤ 1000 ms, `keystrokeAckMs` ≤ 1000 ms)
    // are asserted *inside* the shared helper; this number only
    // bounds the surrounding plumbing (cold-start hand-off →
    // `/projects` → Fly stop + state poll → dashboard re-click).
    // Iter 358 fired the helper's diagnostic with 60 s
    // (cmContentReadyMs=5372); iter 359-360 hit the 60 s testTimeout
    // *before* the diagnostic could fire, so the post-click
    // breakdown never reached production. 120 s leaves headroom
    // for: ≤30 s cold-start + ≤120 s stop settle (rarely all
    // used) + ≤30 s navigate / measure, while keeping a real
    // regression in the cold-from-stopped path observable. The
    // 1000 ms product budgets the helper asserts are unchanged.
    testInfo.setTimeout(120_000);

    await runColdFromInactiveLiveEditableTest(
      {
        label: "verifyLiveGt6LiveEditableStateStopped",
        flyAction: "stop",
        flyState: "stopped",
        settleTimeoutMs: STOP_SETTLE_TIMEOUT_MS,
        projectNamePrefix: "pw-gt6-live-stopped",
      },
      { authedPage, db, testInfo },
    );
  });
});
