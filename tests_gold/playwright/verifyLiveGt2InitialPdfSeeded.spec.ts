// GT-B — "initial PDF for seeded content" (per `172_answer.md`).
//
// Distinct from the existing `verifyLiveFullPipeline.spec.ts`:
// that spec exercises edit→pdf-segment by *typing* the LaTeX
// source. This spec exercises the **no-typing path** — the
// sidecar should compile the seeded `main.tex` template
// immediately on hydrate and ship a `pdf-segment` frame
// without any user input. Iter-162's user report ("initial
// Hello, world! PDF renders fine ... subsequent edits don't")
// suggested this path already worked; landing it as a spec
// locks it in so the iter-176 coalescer refactor can't regress
// it.
//
// Expected to be **green today** in principle, but landed as
// part of the GT-A..D test bundle for completeness. If it fails
// out of the gate, that itself is an interesting finding for
// iter 176 to absorb.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`.
//
// Project + Machine are provided by the worker-scoped
// `liveProject` fixture (shared with GT-A/C/D).

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { captureFrames } from "./fixtures/wireFrames.js";
import { expectPreviewCanvasPainted } from "./fixtures/previewCanvas.js";

test.describe("live initial PDF for seeded content (GT-B)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveInitialPdfSeeded runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("seeded project: pdf-segment arrives without user input", async ({
    authedPage,
    liveProject,
  }) => {
    test.setTimeout(300_000);

    const { pdfSegmentFrames } = captureFrames(authedPage, liveProject.id);

    await authedPage.goto(`/editor/${liveProject.id}`);

    // No typing — the sidecar should hydrate the seeded
    // `main.tex` template and ship a pdf-segment frame on its
    // own. Generous timeout for cold-start + first lualatex.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 240_000,
        message:
          "no pdf-segment frame arrived for the seeded hello-world " +
          "template without user input — the initial-compile path " +
          "is broken",
      })
      .toBeGreaterThan(0);

    // Bounded canvas-painted poll via the shared helper. GT-B
    // used to do a single-shot `canvas.evaluate(nonBlank)`, which
    // is the same race iter 181 surfaced on fullpipeline/reused
    // (the `pdf-segment` frame's arrival doesn't synchronise with
    // PDF.js's async paint). Iter 183 consolidated all five live
    // specs onto the iter-182 bounded-poll primitive.
    await expectPreviewCanvasPainted(authedPage, {
      message:
        "seeded-template preview canvas had no non-near-white pixel " +
        "within timeout — initial-compile PDF rendered blank",
    });
  });
});
