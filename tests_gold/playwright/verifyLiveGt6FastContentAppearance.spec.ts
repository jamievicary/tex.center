// GT-6 — "freshly-navigated /editor/<id> shows source content
// within a tight bound" (per `.autodev/discussion/213_question.md`).
//
// Reported regression: after clicking a project on the dashboard,
// `/editor/<id>` loads but `.cm-content` remains visibly empty
// for up to a minute before the seeded `.tex` source appears.
// The user-visible expectation is "effectively instantaneous"
// (a few hundred ms after navigation completes).
//
// GT-A asserts the no-flash invariant (`.cm-content` never visible
// empty) on a freshly-seeded project with a generous 10s budget;
// it does not pin a tight latency bound. This spec adds the bound.
//
// The shared `liveProject` fixture is already warmed up by
// globalSetup (Machine running, first pdf-segment observed), so a
// fresh page load only needs to clear connect + Yjs hydrate. Any
// content-appearance latency past ~2s on a warm project is the
// regression the user reported.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`. Runs after
// GT-5 in file-sort order. Project state at this point includes
// GT-3/4's appended bytes; we assert against the canonical
// `documentclass` sentinel which is never typed/erased by earlier
// GTs.

import { expect, test } from "./fixtures/sharedLiveProject.js";

// Tight regression bound. The reported pathology is "up to a
// minute"; the user-stated target is "a few hundred ms". 2000ms
// leaves margin for live-deploy variance while still catching any
// recurrence of multi-second content-appearance latency.
const CONTENT_APPEARANCE_TIMEOUT_MS = 2_000;

test.describe("live fast .cm-content appearance (GT-6)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6FastContentAppearance runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("warm project: seeded .tex content appears in .cm-content within a few seconds", async ({
    authedPage,
    liveProject,
  }) => {
    const navStartedAt = Date.now();
    await authedPage.goto(`/editor/${liveProject.id}`);
    const navCompletedAt = Date.now();

    const cmContent = authedPage.locator(".cm-content");

    // Poll for the seed-template sentinel under a tight bound. The
    // assertion failure message captures the elapsed time so a
    // regression is immediately diagnosable.
    let textSeen = "";
    try {
      await expect
        .poll(
          async () => {
            textSeen = (await cmContent.textContent().catch(() => "")) ?? "";
            return textSeen.includes("documentclass");
          },
          {
            timeout: CONTENT_APPEARANCE_TIMEOUT_MS,
            intervals: [50, 100, 200],
            message:
              "`.cm-content` did not contain the seeded `documentclass` " +
              "sentinel within the regression bound after /editor/<id> " +
              "navigation completed.",
          },
        )
        .toBe(true);
    } catch (err) {
      const elapsedMs = Date.now() - navCompletedAt;
      const totalMs = Date.now() - navStartedAt;
      throw new Error(
        `GT-6: seeded content did not appear within ` +
          `${CONTENT_APPEARANCE_TIMEOUT_MS}ms of navigation completing. ` +
          `Elapsed since nav-complete: ${elapsedMs}ms; since goto start: ` +
          `${totalMs}ms. .cm-content textContent at timeout: ${JSON.stringify(
            textSeen.slice(0, 120),
          )}. Underlying: ${(err as Error).message}`,
      );
    }
  });
});
