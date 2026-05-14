// M17.preview-render — regression pin for the per-page cross-fade.
//
// Before iter 271 the PDF preview pane's update path was effectively
// `target.replaceChildren()` on every new `pdf-segment`: the existing
// canvases were detached and the freshly-rendered ones inserted in
// one synchronous swap. To the user this read as a hard flash on
// every recompile.
//
// The redesign (iter 271, `apps/web/src/lib/pdfFadeController.ts` +
// `PdfViewer.svelte`) renders the new canvases off-DOM, then on
// commit appends each new canvas *alongside* the existing one inside
// the page's `.pdf-page` wrapper and cross-fades old→new over 180 ms.
// Wrappers are stable across renders; canvases stack via absolute
// positioning during the fade.
//
// The user-visible invariant is "no codepath ever clears all canvases
// before installing new ones". This pin encodes that as:
//
//   across the window that spans the initial pdf-segment and a
//   keystroke-triggered second pdf-segment, the count of
//   `.pdf-page > canvas` elements observed in a 20-ms-resolution
//   poll must never drop to zero.
//
// The wrapper stability + always-≥1-canvas invariant holds trivially
// under the new design; this pin's value is regression-locking any
// future refactor that re-introduces a `target.replaceChildren()`-
// shaped operation against the host node.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`. Uses the
// worker-scoped `liveProject` fixture; the seeded project's initial
// hello-world compile produces one page, so we only need a single-
// keystroke edit to exercise the cross-fade path.

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { captureFrames } from "./fixtures/wireFrames.js";

// Resolution of the in-page sampler. 20 ms is finer than the 180 ms
// fade duration by a factor of nine, so a transient zero-canvas
// state would have several sample points to land on.
const SAMPLE_INTERVAL_MS = 20;

// How long after the post-edit pdf-segment to keep sampling. The
// fade is 180 ms; 1000 ms gives a wide settle window without
// inflating wallclock.
const POST_SEGMENT_SETTLE_MS = 1_000;

// Bound on the wait for the post-edit pdf-segment to arrive. Mirrors
// GT-C's budget — a single keystroke against a warmed daemon ships
// in well under this.
const POST_EDIT_PDF_TIMEOUT_MS = 10_000;

test.describe("live PDF preview never blanks between segments (M17)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLivePdfNoFlashBetweenSegments runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("`.pdf-page > canvas` count stays ≥1 across a segment swap", async ({
    authedPage,
    liveProject,
  }) => {
    const { pdfSegmentFrames } = captureFrames(authedPage, liveProject.id);

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the initial pdf-segment + at least one rendered
    // canvas under a `.pdf-page` wrapper. Until both are true there
    // is nothing for the cross-fade to fade *from*, and a "0 →
    // first canvas" transition trivially violates the invariant in
    // a way that has nothing to do with the regression class.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 30_000,
        message: "no initial pdf-segment frame (seeded template path broken)",
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        () =>
          authedPage.evaluate(
            () => document.querySelectorAll(".pdf-page > canvas").length,
          ),
        {
          timeout: 30_000,
          message:
            "initial canvas never attached under `.pdf-page` wrapper " +
            "(viewer never installed page-1 canvas)",
        },
      )
      .toBeGreaterThan(0);

    // Start the in-page sampler. setInterval ticks against the
    // page's clock so a Playwright-side `waitForTimeout` between
    // sampler start and edit doesn't lose samples. The sampler
    // records the minimum, maximum, and total sample count to
    // `window.__pdfFlashProbe`.
    await authedPage.evaluate((intervalMs) => {
      const probe: {
        min: number;
        max: number;
        samples: number;
        sumNonZero: number;
        zeroSamples: number;
        firstZeroAt: number | null;
        startTimeMs: number;
        intervalId: number;
      } = {
        min: Number.POSITIVE_INFINITY,
        max: 0,
        samples: 0,
        sumNonZero: 0,
        zeroSamples: 0,
        firstZeroAt: null,
        startTimeMs: performance.now(),
        intervalId: 0,
      };
      (window as unknown as { __pdfFlashProbe: typeof probe }).__pdfFlashProbe =
        probe;
      const tick = () => {
        const n = document.querySelectorAll(".pdf-page > canvas").length;
        probe.samples += 1;
        if (n < probe.min) probe.min = n;
        if (n > probe.max) probe.max = n;
        if (n === 0) {
          probe.zeroSamples += 1;
          if (probe.firstZeroAt === null) {
            probe.firstZeroAt = performance.now() - probe.startTimeMs;
          }
        } else {
          probe.sumNonZero += n;
        }
      };
      // Take a sample immediately, then on the interval.
      tick();
      probe.intervalId = window.setInterval(tick, intervalMs);
    }, SAMPLE_INTERVAL_MS);

    const segmentsBeforeEdit = pdfSegmentFrames.length;

    // Trigger a recompile via a single keystroke. End-of-line append
    // before `\end{document}` mirrors GT-C — exercises the warm
    // compile-coalescer path, not the cold-start path.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 10_000 });
    await cmContent.click();
    await authedPage.keyboard.press("Control+End");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("End");
    await authedPage.keyboard.type("!", { delay: 5 });

    // Wait for the post-edit pdf-segment to land, then keep sampling
    // for POST_SEGMENT_SETTLE_MS so the cross-fade has time to run
    // to completion (or, in the regression, the flash has time to
    // be observed). The sampler keeps running on the page side
    // throughout.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: POST_EDIT_PDF_TIMEOUT_MS,
        message:
          "no post-edit pdf-segment arrived — flash probe inconclusive " +
          "(failure is in the wire path, not the viewer)",
      })
      .toBeGreaterThan(segmentsBeforeEdit);

    await authedPage.waitForTimeout(POST_SEGMENT_SETTLE_MS);

    // Stop the sampler and read the result.
    const probe = await authedPage.evaluate(() => {
      const probe = (
        window as unknown as {
          __pdfFlashProbe: {
            min: number;
            max: number;
            samples: number;
            sumNonZero: number;
            zeroSamples: number;
            firstZeroAt: number | null;
            intervalId: number;
          };
        }
      ).__pdfFlashProbe;
      window.clearInterval(probe.intervalId);
      return {
        min: probe.min,
        max: probe.max,
        samples: probe.samples,
        zeroSamples: probe.zeroSamples,
        firstZeroAt: probe.firstZeroAt,
      };
    });

    expect(
      probe.samples,
      "in-page sampler took zero samples (interval setup broken)",
    ).toBeGreaterThan(10);

    // Core invariant: the canvas count never dropped to zero.
    expect(
      probe.zeroSamples,
      `preview pane flashed empty during a segment swap: ` +
        `samples=${probe.samples}, zeroSamples=${probe.zeroSamples}, ` +
        `min=${probe.min}, max=${probe.max}, ` +
        `firstZeroAt=${probe.firstZeroAt ?? "null"}ms after sampler start. ` +
        "M17 regression — a `.replaceChildren()`-shaped op against the " +
        "viewer host has been re-introduced.",
    ).toBe(0);

    // Belt-and-braces: min must be ≥1 (zeroSamples === 0 implies
    // this, but state it explicitly so a future refactor that
    // changes the zero-detection branch still trips here).
    expect(probe.min).toBeGreaterThanOrEqual(1);
  });
});
