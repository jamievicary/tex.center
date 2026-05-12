// GT-5 — "edit updates the rendered preview canvas" (per
// `188_question.md` / `188_answer.md` slice A).
//
// The four iter-173 specs (GT-A..D) all stop short of asserting
// the preview canvas *content* changes after an edit. GT-C/D
// inspect the WS wire (a second `pdf-segment` arrives) and GT-B
// checks the canvas has any non-near-white pixel — but the
// initial "Hello, world!" canvas already satisfies that, and the
// wire-level checks pass even when byte-identical PDF bytes are
// re-shipped by the sidecar's `assembleSegment` directory-scan
// fallback (see `188_answer.md` for the upstream/sidecar trace).
//
// This spec closes the gap by snapshotting the first preview
// canvas's pixel hash (SHA-256 of the full RGBA buffer), typing a
// visually distinctive payload (`\section{...}`), and asserting
// the post-edit canvas hash differs from the pre-edit hash.
// Strict byte-exact — relaxes to fractional pixel diff only if
// the strict form proves flaky against the live deploy.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`. Uses the
// worker-scoped `liveProject` fixture; runs after GT-D in the
// `verifyLiveGt[1-5]_*` file-sort order.

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { captureFrames } from "./fixtures/wireFrames.js";
import {
  expectPreviewCanvasChanged,
  expectPreviewCanvasPainted,
  snapshotPreviewCanvasHash,
} from "./fixtures/previewCanvas.js";

const EDIT_PAYLOAD = "\n\\section{New Section}\n";

test.describe("live edit updates preview canvas (GT-5)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt5EditUpdatesPreview runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("source edit produces a visually distinct preview canvas", async ({
    authedPage,
    liveProject,
  }) => {
    test.setTimeout(90_000);

    const { pdfSegmentFrames, overlapErrors } = captureFrames(
      authedPage,
      liveProject.id,
    );

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the initial pdf-segment + first painted canvas, then
    // snapshot. Re-snapshot in a bounded poll until we get a stable
    // non-null hash — the canvas may be mid-paint when the first
    // pdf-segment frame arrives.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 5_000,
        message:
          "no initial pdf-segment frame (seeded template path broken)",
      })
      .toBeGreaterThan(0);

    await expectPreviewCanvasPainted(authedPage, {
      message:
        "initial preview canvas never painted within timeout — " +
        "GT-5 pre-edit snapshot would be meaningless",
    });

    let preEditHash: string | null = null;
    await expect
      .poll(
        async () => {
          preEditHash = await snapshotPreviewCanvasHash(authedPage);
          return preEditHash !== null;
        },
        {
          timeout: 30_000,
          message:
            "pre-edit canvas snapshot returned null within timeout — " +
            "canvas getImageData unreadable",
        },
      )
      .toBe(true);
    expect(preEditHash).not.toBeNull();

    // Type a visually distinctive payload at end-of-document. A
    // \section header forces a heading-sized block of ink in a
    // y-region the seeded "Hello, world!" line doesn't occupy, so
    // any non-broken re-render will pixel-diff against the initial.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 10_000 });
    await cmContent.click();
    await authedPage.keyboard.press("Control+End");
    await authedPage.keyboard.type(EDIT_PAYLOAD, { delay: 5 });

    // Assert the canvas hash diverged. 60s budget covers the
    // sidecar's compile coalescer + supertex round + PDF.js paint.
    await expectPreviewCanvasChanged(authedPage, preEditHash!, {
      timeoutMs: 10_000,
    });

    // Sanity: no overlap error during the edit either (covered by
    // GT-C/D for keystroke shapes, replayed here for the multi-char
    // payload — a regression in the coalescer would otherwise pass
    // the canvas-diff with a single fortuitous frame).
    expect(
      overlapErrors,
      "sidecar emitted `another compile already in flight` during " +
        "GT-5 edit — coalescer regressed",
    ).toEqual([]);
  });
});
