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
    // Budget: 1.5× max observed across cases (iter 302: ~26 s; re-run:
    // 38 s on the slower case).
    testInfo.setTimeout(60_000);

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

  // Secondary M15 pin reintroduced iter 289 after the static
  // atomic-replacement case (above) green-passed iter 288. Per
  // iter 288's notes: "If the static spec green-passes, that's
  // the surprise outcome: the bug *is* in the editing path. In
  // which case re-introduce the iter-287 shape-honest editing
  // spec as a secondary case."
  //
  // The user signal that motivated M15 stays load-bearing
  // (`284_answer.md` addendum: preview never shows >1 page even
  // on manually-typed multi-page docs). The static case
  // green-passing means the bug lives in some editing-path shape
  // that the atomic Ctrl+A → type flow doesn't trigger. This
  // case exercises the natural manual flow: open the seeded
  // hello-world project, position the cursor between
  // "Hello, world!" and `\end{document}`, type `\newpage` + a
  // second-page body, await the post-edit compile, assert >1
  // page rendered.
  //
  // Cursor placement is deliberately *inside* the document body:
  // click on the `.cm-line` carrying "Hello, world!", press End,
  // press Enter — this lands the cursor on a fresh line between
  // "Hello, world!" and `\end{document}`, guaranteed inside
  // `\begin{document}...\end{document}`. A shape-sanity assert
  // verifies the typed bytes land between "Hello, world!" and
  // `\end{document}` (catching the iter-284 (β) cursor-past-
  // `\end{document}` failure mode at source level rather than
  // after the compile). If the cursor placement is right and the
  // pin is still RED, (β) is disproved and the bug must be
  // (i) supertex incremental-compile sensitivity to in-body
  // edits, (ii) sidecar broadcast (page 2 not in wire payload),
  // or (iii) PdfViewer (page 2 in wire but not on screen). The
  // failure-path diagnostics here mirror the static case so the
  // same classification tree applies.
  test("in-body manual edit inserting `\\newpage` renders >1 page of canvas", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Budget: 1.5× max observed across cases (iter 302: ~26 s; re-run:
    // 38 s on the slower case).
    testInfo.setTimeout(60_000);

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-probe-multipage-edit-${Date.now()}`,
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

      // `MAIN_DOC_HELLO_WORLD` lines (indexed from 0):
      //   0  \documentclass{article}
      //   1  \begin{document}
      //   2  Hello, world!
      //   3  \end{document}
      // Click line 2 → End → Enter places the cursor on a fresh
      // line between "Hello, world!" and `\end{document}`. No
      // virtual-line trap; the insert is strictly inside the
      // document body. `readCmSource()` below shape-asserts this.
      const helloLine = authedPage.locator(".cm-content .cm-line").nth(2);
      await helloLine.waitFor({ state: "visible", timeout: 10_000 });
      await helloLine.click();
      await authedPage.keyboard.press("End");
      await authedPage.keyboard.press("Enter");
      await authedPage.keyboard.type("\\newpage");
      await authedPage.keyboard.press("Enter");
      await authedPage.keyboard.type("Page two body text.");

      const readCmSource = (): Promise<string> =>
        authedPage.evaluate(() => {
          const lines = Array.from(
            document.querySelectorAll<HTMLElement>(".cm-content .cm-line"),
          );
          return lines.map((l) => l.textContent ?? "").join("\n");
        });

      // Bounded poll for the source DOM to reflect the typed edits.
      let typedSource = await readCmSource();
      const typingDeadline = Date.now() + 5_000;
      while (
        Date.now() < typingDeadline &&
        (!typedSource.includes("\\newpage") ||
          !typedSource.includes("Page two body text."))
      ) {
        await authedPage.waitForTimeout(100);
        typedSource = await readCmSource();
      }

      // Shape sanity: the in-body insert lands between
      // "Hello, world!" and `\end{document}`. Fails fast and
      // surfaces a cursor-placement bug before we wait on the
      // compile — rules out the iter-284 (β) failure mode at
      // source level.
      const idxHello = typedSource.indexOf("Hello, world!");
      const idxNewpage = typedSource.indexOf("\\newpage");
      const idxPageTwo = typedSource.indexOf("Page two body text.");
      const idxEndDoc = typedSource.indexOf("\\end{document}");
      expect(
        idxHello >= 0 &&
          idxNewpage > idxHello &&
          idxPageTwo > idxNewpage &&
          idxEndDoc > idxPageTwo,
        `in-body edit did not land between "Hello, world!" and ` +
          `"\\end{document}". idxHello=${idxHello} ` +
          `idxNewpage=${idxNewpage} idxPageTwo=${idxPageTwo} ` +
          `idxEndDoc=${idxEndDoc} ` +
          `source=${JSON.stringify(typedSource)}`,
      ).toBe(true);

      // Wait for at least one post-edit pdf-segment carrying the
      // multi-page source.
      const deadline = Date.now() + COMPILE_BUDGET_MS;
      while (
        Date.now() < deadline &&
        pdfSegmentFrames.length <= segmentsBefore
      ) {
        await authedPage.waitForTimeout(500);
      }
      if (pdfSegmentFrames.length <= segmentsBefore) {
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
          `no post-edit pdf-segment carrying the in-body \\newpage ` +
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

      // Drain — the viewer renders pages serially after the
      // segment lands, and a late page may still be appending
      // when the wire first goes quiet.
      await authedPage.waitForTimeout(5_000);

      const postEditFrames = pdfSegmentFrames.slice(segmentsBefore);
      const frameBytes = postEditFrames.map((f) => f.length);
      const totalPostEditBytes = frameBytes.reduce((a, b) => a + b, 0);

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
        `preview pane shows only one page of rendered PDF for an ` +
          `in-body \\newpage edit. ` +
          `canvasCount=${measurement.canvasCount} ` +
          `pageWrapperCount=${measurement.pageWrapperCount} ` +
          `tallestPx=${measurement.tallestPx.toFixed(1)} ` +
          `viewportH=${measurement.viewportH} ` +
          `hostScrollH=${measurement.hostScrollH ?? "null"} ` +
          `postEditFrameCount=${postEditFrames.length} ` +
          `postEditBytes=${totalPostEditBytes} ` +
          `frameBytes=${JSON.stringify(frameBytes)}. ` +
          `Reproduces the user's manually-typed-multi-page report ` +
          `(284_answer.md addendum). Classify per static-case ` +
          `comment block: 1 frame + small bytes → supertex or ` +
          `sidecar broadcast suspect; many/large frames → viewer ` +
          `suspect.`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });

  // M21.2 / priority #1 iter B-gold (per `.autodev/PLAN.md`,
  // `369b_answer.md`). The first case above asserts
  // `pageWrapperCount ≥ 2` for a static two-page source — but that
  // count is satisfied by the iter-372 `.pdf-page-placeholder` slot
  // alone, so it never validates that the bootstrap-cascade chain
  // actually replaces the placeholder with a real page 2. This
  // case closes that gap by exercising every hop:
  //
  //   1. Fresh project, static two-page source via Ctrl+A → type.
  //   2. Post-replace pdf-segment ships `shipoutPage=1,
  //      lastPage=false` (target capped to `maxViewingPage=1`).
  //   3. PdfViewer mounts `.pdf-page-placeholder` for page 2.
  //   4. `placeholderEl.scrollIntoView()` → IntersectionObserver
  //      fires (ratio > 0.1 threshold) → `setViewingPage(2)` →
  //      outgoing `view` frame → sidecar `kickForView(2)` →
  //      recompile with `targetPage=2`.
  //   5. Post-cascade pdf-segment ships `shipoutPage≥2,
  //      lastPage=true`.
  //   6. PdfViewer removes placeholder, two *real* `.pdf-page`
  //      wrappers (no `pdf-page-placeholder` class) live in the
  //      DOM.
  //
  // `lastPage` is the new tri-state byte at frame-offset 18 (i.e.
  // payload[17]) — encoder writes 2=true / 1=false / 0=unset
  // (`packages/protocol/src/index.ts`). Parsed inline here so the
  // wireFrames fixture stays minimal.
  test("bootstrap cascade: scroll into placeholder triggers page-2 fetch and replaces placeholder", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Outer envelope: cold first-compile ≤90 s + replace-and-
    // recompile ≤60 s + scroll-cascade compile ≤60 s + slack.
    testInfo.setTimeout(240_000);

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-probe-cascade-${Date.now()}`,
    });

    const { pdfSegmentFrames, compileStatusEvents } = captureFrames(
      authedPage,
      project.id,
    );

    // Per-frame parse for lastPage. `null` ≡ legacy header (< 18 B)
    // or the new tri-state's `unset` value — neither matches the
    // page-2 cascade success shape, which requires `true`.
    const parseLastPage = (frame: Buffer): boolean | null => {
      if (frame.length < 18) return null;
      const byte = frame.readUInt8(17);
      if (byte === 2) return true;
      if (byte === 1) return false;
      return null;
    };
    const parseShipoutPage = (frame: Buffer): number | null => {
      if (frame.length < 17) return null;
      const raw = frame.readUInt32BE(13);
      return raw > 0 ? raw : null;
    };

    try {
      await authedPage.goto(`/editor/${project.id}`);

      const cmContent = authedPage.locator(".cm-content");
      await cmContent.waitFor({ state: "visible", timeout: 60_000 });

      // Initial cold-compile hello-world segment + canvas paint,
      // so we know the per-project Machine is warm before we
      // replace the source.
      await expect
        .poll(() => pdfSegmentFrames.length, {
          timeout: COMPILE_BUDGET_MS,
          message:
            "no initial pdf-segment for seeded hello-world template",
        })
        .toBeGreaterThan(0);
      await expectPreviewCanvasPainted(authedPage);

      const segmentsBefore = pdfSegmentFrames.length;

      // Atomic replace, identical mechanism to the static case
      // above. The post-replace compile ships page 1 only (target
      // capped to maxViewingPage=1) with `lastPage=false`.
      await cmContent.click();
      await authedPage.keyboard.press("Control+a");
      await authedPage.keyboard.type(STATIC_TWO_PAGE);

      // Wait for the page-2 placeholder to mount. This is the
      // single load-bearing signal that (a) the post-replace
      // compile shipped, (b) it carried `lastPage=false`, and
      // (c) PdfViewer's `syncPlaceholder` ran after the commit.
      // Any other failure mode (compile errored, segment lost on
      // the wire, viewer crashed) prevents the placeholder from
      // appearing and surfaces here as a timeout.
      const placeholder = authedPage.locator(".pdf-page-placeholder");
      try {
        await placeholder.waitFor({ state: "attached", timeout: 90_000 });
      } catch (err) {
        // Failure-mode diagnostics: surface the segment shapes
        // observed since `segmentsBefore` so the failing message
        // classifies which hop is broken.
        const postReplaceFrames = pdfSegmentFrames.slice(segmentsBefore);
        const shapes = postReplaceFrames.map((f) => ({
          bytes: f.length,
          shipoutPage: parseShipoutPage(f),
          lastPage: parseLastPage(f),
        }));
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
        throw new Error(
          `placeholder never mounted within 90 s after the ` +
            `Ctrl+A → type replacement. ` +
            `postReplaceFrameCount=${postReplaceFrames.length} ` +
            `shapes=${JSON.stringify(shapes)} ` +
            `compileStatusEvents=${csSummary} ` +
            `original=${err instanceof Error ? err.message : String(err)}. ` +
            `Classification: 0 post-replace segments + no error → ` +
            `coalescer never fired; ≥1 with lastPage===null or true → ` +
            `sidecar didn't stamp lastPage on a 2-page source; ` +
            `≥1 with lastPage===false but placeholder absent → ` +
            `PdfViewer.syncPlaceholder() broke.`,
        );
      }

      const segmentsAtPlaceholder = pdfSegmentFrames.length;

      // Scroll the placeholder into view. Triggers IO → tracker
      // promotes maxVisible to 2 → `setViewingPage(2)` →
      // outgoing `view` frame → sidecar `kickForView(2)`.
      await placeholder.scrollIntoViewIfNeeded();

      // Await a post-cascade pdf-segment with both lastPage=true
      // and shipoutPage ≥ 2. Either signal alone is insufficient:
      // a coincidental compile with lastPage=true on page 1 (a
      // single-page document re-emitted) would have shipoutPage=1.
      const cascadeDeadline = Date.now() + 90_000;
      let cascadeSeg: { idx: number; shipoutPage: number | null } | null = null;
      while (Date.now() < cascadeDeadline) {
        for (let i = segmentsAtPlaceholder; i < pdfSegmentFrames.length; i++) {
          const f = pdfSegmentFrames[i]!;
          if (parseLastPage(f) === true) {
            const sp = parseShipoutPage(f);
            if (sp !== null && sp >= 2) {
              cascadeSeg = { idx: i, shipoutPage: sp };
              break;
            }
          }
        }
        if (cascadeSeg) break;
        await authedPage.waitForTimeout(250);
      }

      if (!cascadeSeg) {
        const postCascadeFrames = pdfSegmentFrames.slice(segmentsAtPlaceholder);
        const shapes = postCascadeFrames.map((f) => ({
          bytes: f.length,
          shipoutPage: parseShipoutPage(f),
          lastPage: parseLastPage(f),
        }));
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
        expect(
          cascadeSeg,
          `no pdf-segment with shipoutPage≥2 AND lastPage=true ` +
            `arrived within 90 s of scrolling the placeholder into ` +
            `view. ` +
            `postCascadeFrameCount=${postCascadeFrames.length} ` +
            `shapes=${JSON.stringify(shapes)} ` +
            `compileStatusEvents=${csSummary}. ` +
            `Classification: 0 post-scroll segments → IO didn't ` +
            `fire OR setViewingPage() didn't reach sidecar OR ` +
            `kickForView skipped (check sidecar log for ` +
            `kickForView-skip with reason); ≥1 with ` +
            `shipoutPage=1 → sidecar still capping target at 1 ` +
            `(maxViewingPage state lost); ≥1 with ` +
            `shipoutPage=2 + lastPage=false → engine didn't ` +
            `hit \\enddocument at page 2 (upstream supertex).`,
        ).not.toBeNull();
      }

      // The PdfViewer must remove the placeholder and add a
      // second real `.pdf-page` wrapper after the cascade segment
      // commits. Bounded poll on the DOM rather than a fixed
      // sleep: the render is bytes→pdfjs→canvases→commit, so a
      // few hundred ms of slack is enough on a warm Machine.
      const renderDeadline = Date.now() + 30_000;
      let realPages = 0;
      let placeholderCount = 1;
      while (Date.now() < renderDeadline) {
        const counts = await authedPage.evaluate(() => ({
          realPages: document.querySelectorAll(
            ".preview .pdf-page:not(.pdf-page-placeholder)",
          ).length,
          placeholderCount: document.querySelectorAll(
            ".preview .pdf-page-placeholder",
          ).length,
        }));
        realPages = counts.realPages;
        placeholderCount = counts.placeholderCount;
        if (realPages >= 2 && placeholderCount === 0) break;
        await authedPage.waitForTimeout(250);
      }

      expect(
        realPages >= 2 && placeholderCount === 0,
        `bootstrap cascade rendered, but the viewer did not ` +
          `replace the placeholder with a real page 2 within 30 s. ` +
          `realPages=${realPages} placeholderCount=${placeholderCount}. ` +
          `Classification: realPages=1 + placeholderCount=1 → ` +
          `cascade segment arrived but PdfViewer's render() didn't ` +
          `commit a 2-page descriptor list (check pdfjs path); ` +
          `realPages=2 + placeholderCount=1 → ` +
          `syncPlaceholder() didn't remove the slot after commit ` +
          `(lastPage prop never flipped to true on PdfViewer).`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
