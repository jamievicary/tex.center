// M15 — multi-page preview pin (per `287_answer.md` static
// reframe of `241_answer.md` /
// `.autodev/PLAN.md` §M15.multipage-preview).
//
// User report: the PDF preview has NEVER shown more than 1 page,
// even on manually-typed multi-page documents (`284_answer.md`
// addendum). Prior iter-275/276/279 narratives chased an upstream
// short-circuit hypothesis without ever confirming the bytes the
// sidecar wrote. Iter 287's instruction: stop chasing
// editing-path hypotheses; verify the trivial static case first.
//
// Practical impasse (see `287_answer.md`): there is no
// seed-override mechanism — `MAIN_DOC_HELLO_WORLD` is hard-coded
// in `packages/protocol/src/index.ts` and seeded into the Y.Text
// on first sidecar hydration. Without implementing a per-project
// seed override (forbidden this iteration), the closest faithful
// "static multi-page source" we can produce is `Ctrl+A` →
// `keyboard.type(STATIC_TWO_PAGE)` — atomic replacement, one
// transaction, no cursor positioning, no virtual-line trap, no
// per-keystroke coalescer cadence. From the supertex daemon's,
// sidecar's, and viewer's perspectives, the source is the exact
// 5-line two-page document below.
//
// Three candidate failure locations the static framing
// disambiguates between:
//   (i)   supertex compile output: only one shipout for the
//         two-page source.
//   (ii)  sidecar broadcast: shipout has ≥2 pages but the wire
//         payload carries only page 1.
//   (iii) PdfViewer: wire carries ≥2 pages but the viewer
//         renders only one.
//
// Failure-path diagnostics emit per-frame byte sizes and a
// compile-status timeline so the failure message directly feeds
// the (i)/(ii)/(iii) classification. Local sidecar pins
// `test_supertex_multipage_emit.py` and
// `test_supertex_incremental_multipage_emit.py` are GREEN on
// static 2-page sources, so a (i) failure on live would be a
// fresh upstream finding rather than a known issue.
//
// Asserts the preview pane ends up with **either** ≥2
// `.pdf-page` wrappers **or** a single canvas whose `height >
// viewport.height * 1.8` — both encode "more than one page
// worth of content rendered", and at least one holds across all
// candidate fix shapes.
//
// Expected RED until M15 diagnose-and-fix lands. Failures gate
// `.autodev/finished.md` but do not revert the iteration.

import { createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { expectPreviewCanvasPainted } from "./fixtures/previewCanvas.js";
import { captureFrames } from "./fixtures/wireFrames.js";

// The exact 5-line two-page LaTeX document from
// `287_question.md`. `\newpage` is an unconditional break in
// `article`, so this produces a 2-page PDF irrespective of font
// metrics. Trailing `\n` retained for LaTeX-friendliness.
const STATIC_TWO_PAGE =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Page one body text.\n" +
  "\\newpage\n" +
  "Page two body text.\n" +
  "\\end{document}\n";

// Wallclock budget for the compile to land. A cold per-project
// Machine takes ~60-90 s for first compile (see GT-8); give the
// post-replace compile generous slack on top.
const COMPILE_BUDGET_MS = 180_000;

test.describe("live multi-page PDF preview (M15)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLivePdfMultiPage runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("static two-page source renders >1 page of canvas in the preview pane", async ({
    authedPage,
    db,
  }, testInfo) => {
    testInfo.setTimeout(360_000);

    // Fresh project per invocation — keeps the seed window clean
    // and avoids polluting the shared GT-A/B/C/D liveProject body.
    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-probe-multipage-${Date.now()}`,
    });

    const { pdfSegmentFrames, docUpdateSent, compileStatusEvents } =
      captureFrames(authedPage, project.id);

    try {
      await authedPage.goto(`/editor/${project.id}`);

      const cmContent = authedPage.locator(".cm-content");
      await cmContent.waitFor({ state: "visible", timeout: 60_000 });

      // Wait for the initial pdf-segment + first painted canvas
      // (one-page hello-world compile) so we know the daemon is
      // warm before we replace.
      await expect
        .poll(() => pdfSegmentFrames.length, {
          timeout: COMPILE_BUDGET_MS,
          message:
            "no initial pdf-segment for seeded hello-world template",
        })
        .toBeGreaterThan(0);
      await expectPreviewCanvasPainted(authedPage);

      const segmentsBefore = pdfSegmentFrames.length;

      // Atomic content replacement. Click → Ctrl+A → type:
      // CodeMirror's selection-replace dispatches a single
      // transaction that swaps the entire document for
      // STATIC_TWO_PAGE. No cursor placement, no virtual-line
      // trap, no per-keystroke timing artefacts. The wire sees
      // one Yjs op carrying the full document.
      await cmContent.click();
      await authedPage.keyboard.press("Control+a");
      await authedPage.keyboard.type(STATIC_TWO_PAGE);

      // Read the page's view of the source by joining `.cm-line`
      // textContent with `\n` (CodeMirror renders one `.cm-line`
      // per logical line; `.cm-content`'s direct `textContent`
      // loses newlines). Bounded poll up to 3 s for the DOM to
      // reflect the replacement.
      const readCmSource = (): Promise<string> =>
        authedPage.evaluate(() => {
          const lines = Array.from(
            document.querySelectorAll<HTMLElement>(".cm-content .cm-line"),
          );
          return lines.map((l) => l.textContent ?? "").join("\n");
        });
      let typedSource = await readCmSource();
      const typingDeadline = Date.now() + 3_000;
      while (
        Date.now() < typingDeadline &&
        (!typedSource.includes("\\newpage") ||
          !typedSource.includes("Page two body text."))
      ) {
        await authedPage.waitForTimeout(100);
        typedSource = await readCmSource();
      }
      // Sanity: the replacement landed at the source level.
      // STATIC_TWO_PAGE is the exact 5-line document; the
      // `.cm-content` view should reflect it (modulo any
      // CodeMirror trailing-newline rendering quirks, hence the
      // structural rather than exact match here).
      expect(
        typedSource.includes("\\newpage") &&
          typedSource.includes("Page one body text.") &&
          typedSource.includes("Page two body text."),
        `Ctrl+A → type did not replace the document. ` +
          `sourceLen=${typedSource.length} ` +
          `source=${JSON.stringify(typedSource)}`,
      ).toBe(true);

      // Wait for at least one post-replace pdf-segment so we know
      // the compile carrying the two-page body has shipped.
      const deadline = Date.now() + COMPILE_BUDGET_MS;
      while (
        Date.now() < deadline &&
        pdfSegmentFrames.length <= segmentsBefore
      ) {
        await authedPage.waitForTimeout(500);
      }
      if (pdfSegmentFrames.length <= segmentsBefore) {
        // Distinguishes "coalescer never fired" / "compile
        // errored" / "compile succeeded but no segment" failure
        // modes. With STATIC_TWO_PAGE as the source shape, a
        // compile error here would be a fresh upstream finding —
        // local pin `test_supertex_multipage_emit.py` shows
        // supertex handles this exact shape correctly.
        const finalSource = await readCmSource();
        const csCounts = compileStatusEvents.reduce<Record<string, number>>(
          (acc, e) => {
            acc[e.state] = (acc[e.state] ?? 0) + 1;
            return acc;
          },
          {},
        );
        const csSummary =
          Object.entries(csCounts)
            .map(([s, n]) => `${s}×${n}`)
            .join(",") || "none";
        const lastErrorDetail =
          [...compileStatusEvents]
            .reverse()
            .find((e) => e.state === "error")?.detail ?? null;
        expect(
          pdfSegmentFrames.length,
          `no post-replace pdf-segment carrying the static two-page ` +
            `source arrived within ${COMPILE_BUDGET_MS}ms. ` +
            `segmentsBefore=${segmentsBefore} ` +
            `pdfSegmentsAtFail=${pdfSegmentFrames.length} ` +
            `docUpdateSent=${docUpdateSent.value} ` +
            `finalSourceLen=${finalSource.length} ` +
            `finalSource=${JSON.stringify(finalSource)} ` +
            `compileStatusEvents=${csSummary} ` +
            `lastErrorDetail=${JSON.stringify(lastErrorDetail)}`,
        ).toBeGreaterThan(segmentsBefore);
      }

      // Drain — the viewer renders pages serially after the
      // segment lands, and a late page may still be appending
      // when the wire first goes quiet.
      await authedPage.waitForTimeout(5_000);

      // Per-frame byte sizes feed the (i)/(ii)/(iii) failure
      // classification: a tiny single post-replace segment
      // implicates supertex/sidecar; a large or multiple
      // segments with a one-page DOM implicates the viewer.
      const postReplaceFrames = pdfSegmentFrames.slice(segmentsBefore);
      const frameBytes = postReplaceFrames.map((f) => f.length);
      const totalPostReplaceBytes = frameBytes.reduce((a, b) => a + b, 0);

      const measurement = await authedPage.evaluate(() => {
        const host = document.querySelector(".preview .host");
        const canvases = Array.from(
          document.querySelectorAll<HTMLCanvasElement>(".preview canvas"),
        );
        const pageWrappers = document.querySelectorAll(".preview .pdf-page");
        const heights = canvases.map((c) => c.getBoundingClientRect().height);
        const tallestPx = heights.reduce((m, h) => (h > m ? h : m), 0);
        return {
          canvasCount: canvases.length,
          pageWrapperCount: pageWrappers.length,
          tallestPx,
          viewportH: window.innerHeight,
          hostScrollH: (host as HTMLElement | null)?.scrollHeight ?? null,
        };
      });

      const viewerAgnosticOk =
        measurement.pageWrapperCount >= 2 ||
        measurement.tallestPx > measurement.viewportH * 1.8;

      expect(
        viewerAgnosticOk,
        `preview pane shows only one page of rendered PDF for the ` +
          `static two-page source. ` +
          `canvasCount=${measurement.canvasCount} ` +
          `pageWrapperCount=${measurement.pageWrapperCount} ` +
          `tallestPx=${measurement.tallestPx.toFixed(1)} ` +
          `viewportH=${measurement.viewportH} ` +
          `hostScrollH=${measurement.hostScrollH ?? "null"} ` +
          `postReplaceFrameCount=${postReplaceFrames.length} ` +
          `postReplaceBytes=${totalPostReplaceBytes} ` +
          `frameBytes=${JSON.stringify(frameBytes)}. ` +
          `Expected ≥2 .pdf-page wrappers OR a single canvas > ` +
          `1.8× viewport height for a 2-page LaTeX source. ` +
          `Classify per 287_answer.md: 1 frame + small bytes → ` +
          `supertex or sidecar broadcast suspect; many/large ` +
          `frames → viewer suspect.`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
