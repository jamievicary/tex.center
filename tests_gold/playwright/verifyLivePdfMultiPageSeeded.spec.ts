// M15 Step D — `seedMainDoc` end-to-end pin.
//
// Both M15 editing pins (`verifyLivePdfMultiPage` — static
// atomic-replace and in-body manual edit) have been GREEN since
// iter 288 / 289 (the "second surprise" per `287_answer.md` and
// PLAN M15). The user's `284_answer.md` addendum claim — "the
// PDF preview has NEVER shown more than 1 page, even on
// manually-typed multi-page documents" — is therefore not
// reproducible by any Playwright editing flow we have written.
//
// This spec drops the editing path entirely. It creates a
// project whose `projects.seed_doc` column is a literal 5-line
// 2-page LaTeX source, opens it, waits for the initial compile
// (the seeded bytes go through the same supertex/sidecar/viewer
// path on first hydration as if the user had typed them and
// nothing else), and asserts ≥2 pages render with **zero**
// keyboard input.
//
// Two informative outcomes:
//
//   (α) Green. Decisive: the bug the user reports is in some
//       path neither this seeded flow nor the two editing pins
//       exercises. Most likely candidate: the user's actual
//       `main.tex` contains a LaTeX construct (package,
//       environment, math mode, figure) that our 2-page seeds
//       don't. Next action is to ask the user for the offending
//       source via discussion mode.
//
//   (β) Red. Decisive: the bug reproduces with no editing at
//       all. Then deploy the iter-286 `compile-source` /
//       `daemon-stdin` / `daemon-stderr` debug logs (already
//       default-on in `apps/sidecar/src/server.ts`) and
//       `flyctl logs -a tex-center-sidecar --no-tail` to
//       classify per M15 Step C' (i)/(ii)/(iii) — exactly as
//       documented in PLAN M15.
//
// The plumbing path under test:
//   `createProject(db, { ..., seedMainDoc: STATIC_TWO_PAGE })`
//     → `projects.seed_doc` column populated
//     → on first `/ws/project/<id>` upgrade, the per-project
//       upstream resolver (`apps/web/src/lib/server/
//       upstreamResolver.ts`) fetches `seed_doc` via
//       `getProjectSeedDoc` and bakes it into the new
//       Machine's env as `SEED_MAIN_DOC_B64`
//     → the sidecar (`apps/sidecar/src/server.ts`) reads the
//       env, base64-decodes, and passes through to
//       `createProjectPersistence({ seedMainDoc })`
//     → first-hydration code path seeds `Y.Text("main.tex")`
//       with the override bytes (no blob exists yet) and PUTs
//       the blob.
//
// Asserts the preview pane ends up with **either** ≥2 `.pdf-page`
// wrappers **or** a single canvas whose `height > viewport.height
// * 1.8` — both encode "more than one page worth of content
// rendered". Mirrors the assertion shape of the existing
// `verifyLivePdfMultiPage` pins so a future fix that makes one
// green is likely to make the other green too.

import { createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { captureFrames } from "./fixtures/wireFrames.js";

// Same 5-line 2-page LaTeX source as the existing
// `verifyLivePdfMultiPage.spec.ts` static case. `\newpage` is an
// unconditional break in `article`, so this produces a 2-page
// PDF irrespective of font metrics.
const STATIC_TWO_PAGE =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Page one body text.\n" +
  "\\newpage\n" +
  "Page two body text.\n" +
  "\\end{document}\n";

// Wallclock budget for the cold per-project Machine to come up
// and the seeded first compile to land. Mirrors the
// `verifyLivePdfMultiPage` static case (180s).
const COMPILE_BUDGET_MS = 180_000;

test.describe("live seeded multi-page PDF preview (M15 Step D)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLivePdfMultiPageSeeded runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("seeded two-page source renders >1 page with zero editing", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Budget: iter 302 observed 25.8 s; the validation re-run hit
    // 45.2 s on a colder Machine. 75 s = 1.5× the latest observed
    // worst case, ~3× the median.
    testInfo.setTimeout(75_000);

    // Fresh project per invocation. The seed_doc column is the
    // only thing this spec cares about — no editing, no typing.
    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-probe-multipage-seeded-${Date.now()}`,
      seedMainDoc: STATIC_TWO_PAGE,
    });

    const { pdfSegmentFrames, docUpdateSent, compileStatusEvents } =
      captureFrames(authedPage, project.id);

    try {
      await authedPage.goto(`/editor/${project.id}`);

      const cmContent = authedPage.locator(".cm-content");
      await cmContent.waitFor({ state: "visible", timeout: 60_000 });

      // Wait for the initial pdf-segment (the seeded two-page
      // compile). No edits, no typing — the sidecar's first
      // hydration writes the seed into the Y.Text and the
      // coalescer fires the first compile. The wire should
      // carry pages 1 and 2 in that one compile cycle.
      const deadline = Date.now() + COMPILE_BUDGET_MS;
      while (
        Date.now() < deadline &&
        pdfSegmentFrames.length === 0
      ) {
        await authedPage.waitForTimeout(500);
      }
      if (pdfSegmentFrames.length === 0) {
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
          `no pdf-segment for seeded two-page source arrived within ` +
            `${COMPILE_BUDGET_MS}ms. ` +
            `docUpdateSent=${docUpdateSent.value} ` +
            `compileStatusEvents=${csSummary} ` +
            `lastErrorDetail=${JSON.stringify(lastErrorDetail)}. ` +
            `If compile-status is "error", the seed_doc plumbing ` +
            `(createProject → upstreamResolver env → sidecar) ` +
            `may be broken — check that the new Machine was created ` +
            `with SEED_MAIN_DOC_B64 in its env.`,
        ).toBeGreaterThan(0);
      }

      // Drain — the viewer renders pages serially after the
      // segment lands, and a late page may still be appending
      // when the wire first goes quiet.
      await authedPage.waitForTimeout(5_000);

      const frameBytes = pdfSegmentFrames.map((f) => f.length);
      const totalBytes = frameBytes.reduce((a, b) => a + b, 0);

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
        `preview pane shows only one page for a project seeded ` +
          `with a literal two-page LaTeX source (zero edits). ` +
          `canvasCount=${measurement.canvasCount} ` +
          `pageWrapperCount=${measurement.pageWrapperCount} ` +
          `tallestPx=${measurement.tallestPx.toFixed(1)} ` +
          `viewportH=${measurement.viewportH} ` +
          `hostScrollH=${measurement.hostScrollH ?? "null"} ` +
          `frameCount=${pdfSegmentFrames.length} ` +
          `totalBytes=${totalBytes} ` +
          `frameBytes=${JSON.stringify(frameBytes)}. ` +
          `Per PLAN M15 Step D (β): if this fails, the bug is ` +
          `reproducible with zero editing. Deploy iter-286 ` +
          `compile-source / daemon-stdin / daemon-stderr debug ` +
          `logs and classify per Step C' (i)/(ii)/(iii).`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
