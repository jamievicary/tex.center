// M15 — multi-page preview pin (per `241_answer.md` /
// `.autodev/PLAN.md` §M15.multipage-preview).
//
// User report: a project body that compiles to ≥3 pages renders
// only page 1 in the live preview pane. This pin reproduces the
// shape against live, deliberately viewer-agnostic so it survives
// any of the three candidate fixes named in `241_answer.md`:
//
//   (a) wire-format `totalLength` capped at page-1 size,
//   (b) `PdfViewer` snapshot reference-equality short-circuit,
//   (c) `.preview` CSS overflow clipping.
//
// Asserts the preview pane ends up with **either** ≥2
// `canvas[data-page]` children **or** a single canvas whose
// `height > viewport.height * 1.8` — both encode "more than one
// page worth of content rendered", and at least one holds across
// all three fix shapes.
//
// Expected RED until M15 diagnose-and-fix lands. Failures gate
// `.autodev/finished.md` but do not revert the iteration.

import { createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { expectPreviewCanvasPainted } from "./fixtures/previewCanvas.js";
import { captureFrames } from "./fixtures/wireFrames.js";

// Body fragment inserted before `\end{document}` to force a
// multi-page PDF. `\newpage` is an unconditional page break in
// `article`, so four breaks plus the seeded "Hello, world!" line
// produces a 5-page PDF irrespective of font metrics. Each page
// carries a short tag so the rendered bytes differ between pages
// (rules out a degenerate "all pages identical, viewer collapses"
// case during diagnosis).
const MULTIPAGE_BODY =
  "\\newpage Page two body text.\n" +
  "\\newpage Page three body text.\n" +
  "\\newpage Page four body text.\n" +
  "\\newpage Page five body text.\n";

// Wallclock budget for the multi-page compile to land. A cold
// per-project Machine takes ~60-90 s for first compile (see GT-8);
// give the post-edit compile generous slack on top.
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

  test("≥3-page compile renders >1 page worth of canvas in the preview pane", async ({
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
      // warm before we edit.
      await expect
        .poll(() => pdfSegmentFrames.length, {
          timeout: COMPILE_BUDGET_MS,
          message:
            "no initial pdf-segment for seeded hello-world template",
        })
        .toBeGreaterThan(0);
      await expectPreviewCanvasPainted(authedPage);

      const segmentsBefore = pdfSegmentFrames.length;

      // Position just before `\end{document}` and insert the
      // multipage body. Mirrors the GT-D / GT-5 cursor preamble.
      await cmContent.click();
      await authedPage.keyboard.press("Control+End");
      await authedPage.keyboard.press("ArrowUp");
      await authedPage.keyboard.press("End");
      await authedPage.keyboard.press("Enter");
      await authedPage.keyboard.type(MULTIPAGE_BODY, { delay: 5 });

      // M15 Step B — surface the
      // "body typed past `\end{document}`" failure mode directly,
      // *before* the no-segment polling loop times out. If the test's
      // keyboard sequence (Ctrl+End → ArrowUp → End → Enter) lands
      // the cursor on the SEED's virtual blank trailing line, the
      // typed body lands after `\end{document}` and supertex
      // correctly emits one page — the bug is then client-side
      // (cursor placement / SEED trailing newline / keyboard
      // sequence), not the daemon. Per `284_answer.md` §"Resolution
      // / plan".
      const readCmSource = (): Promise<string> =>
        authedPage.evaluate(() => {
          const lines = Array.from(
            document.querySelectorAll<HTMLElement>(".cm-content .cm-line"),
          );
          return lines.map((l) => l.textContent ?? "").join("\n");
        });
      // Allow CodeMirror's view to render the typed keystrokes
      // before we read. `keyboard.type` resolves once the input
      // events have dispatched; CodeMirror applies synchronously
      // but the `.cm-line` DOM may need one paint tick for the new
      // virtual lines to materialise.
      let typedSource = await readCmSource();
      const typingDeadline = Date.now() + 3_000;
      while (
        Date.now() < typingDeadline &&
        !typedSource.includes("\\newpage")
      ) {
        await authedPage.waitForTimeout(100);
        typedSource = await readCmSource();
      }
      const newpageIdx = typedSource.indexOf("\\newpage");
      const endDocIdx = typedSource.indexOf("\\end{document}");
      expect(
        newpageIdx >= 0 && endDocIdx >= 0 && newpageIdx < endDocIdx,
        `keyboard sequence produced wrong shape: \\newpage was not ` +
          `typed before \\end{document}. ` +
          `newpageIdx=${newpageIdx} endDocIdx=${endDocIdx} ` +
          `sourceLen=${typedSource.length} ` +
          `source=${JSON.stringify(typedSource)}. ` +
          `If newpageIdx > endDocIdx, the cursor landed on the ` +
          `SEED's virtual blank trailing line and the body was ` +
          `inserted past \\end{document} — supertex correctly ` +
          `short-circuits and emits only page 1; the bug is ` +
          `client-side, not in the daemon.`,
      ).toBe(true);

      // Wait for at least one post-edit pdf-segment so we know the
      // compile carrying the multipage body has shipped.
      const deadline = Date.now() + COMPILE_BUDGET_MS;
      while (
        Date.now() < deadline &&
        pdfSegmentFrames.length <= segmentsBefore
      ) {
        await authedPage.waitForTimeout(500);
      }
      if (pdfSegmentFrames.length <= segmentsBefore) {
        // Diagnostic snapshot — iter 274 made this branch surface
        // why the compile didn't fire (no DOC_UPDATE sent? typing
        // didn't reach `.cm-content`? WS not bound to this
        // project?). Three RED gold runs (271/272/273) gave us
        // zero data to choose between those modes.
        // M15 Step B — emit the full final source the page believes
        // it has, not just a 40-byte tail. The tail couldn't
        // disambiguate "body before vs after \end{document}".
        const finalSource = await readCmSource();
        // iter 275: compile-status timeline distinguishes
        // "coalescer never fired" / "compile errored" / "compile
        // succeeded but no segment" failure modes.
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
          `no post-edit pdf-segment carrying the multipage body ` +
            `arrived within ${COMPILE_BUDGET_MS}ms. ` +
            `segmentsBefore=${segmentsBefore} ` +
            `pdfSegmentsAtFail=${pdfSegmentFrames.length} ` +
            `docUpdateSent=${docUpdateSent.value} ` +
            `finalSourceLen=${finalSource.length} ` +
            `finalSource=${JSON.stringify(finalSource)} ` +
            `compileStatusEvents=${csSummary} ` +
            `lastErrorDetail=${JSON.stringify(lastErrorDetail)}`,
        ).toBeGreaterThan(segmentsBefore);
      }

      // Drain — the viewer renders pages serially after the segment
      // lands, and a late page may still be appending when the wire
      // first goes quiet.
      await authedPage.waitForTimeout(5_000);

      const measurement = await authedPage.evaluate(() => {
        const host = document.querySelector(".preview .host");
        const canvases = Array.from(
          document.querySelectorAll<HTMLCanvasElement>(".preview canvas"),
        );
        // Iter 271 moved `data-page` from canvas to the
        // `.pdf-page` wrapper (M17 cross-fade rewrite); count the
        // wrappers, not the canvases.
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
        `preview pane shows only one page of rendered PDF. ` +
          `canvasCount=${measurement.canvasCount} ` +
          `pageWrapperCount=${measurement.pageWrapperCount} ` +
          `tallestPx=${measurement.tallestPx.toFixed(1)} ` +
          `viewportH=${measurement.viewportH} ` +
          `hostScrollH=${measurement.hostScrollH ?? "null"}. ` +
          `Expected ≥2 .pdf-page wrappers OR a single canvas > 1.8× ` +
          `viewport height after typing 4 \\newpage breaks.`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
