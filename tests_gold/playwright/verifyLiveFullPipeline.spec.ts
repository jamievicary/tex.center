// M8.pw.4 — full product-loop spec.
//
// Drives the deployed `tex.center` end-to-end as an authenticated
// user:
//
//   1. Seed a fresh project owned by the live test user.
//   2. Navigate the authed browser to `/editor/<id>`.
//   3. Type a minimal compilable LaTeX source into CodeMirror.
//   4. Wait for the first `pdf-segment` (tag `0x20`) binary frame
//      to arrive on the per-project WebSocket — proof that the
//      control-plane proxy reached the per-project sidecar
//      Machine, supertex compiled, and the wire codec round-
//      tripped.
//   5. Assert PDF.js rendered a non-blank canvas in the preview
//      pane.
//
// Live-only and additionally gated on `TEXCENTER_FULL_PIPELINE=1`
// so it does not beat on production on every iteration. Mandatory
// on deploy-touching iterations.
//
// The fresh project row and its per-project Machine are reaped
// in `afterEach` via `cleanupLiveProjectMachine` (see
// `173b_answer.md` — idle-stop is an optimisation, not a
// correctness guarantee for test cleanup; specs must reap what
// they spawn). The reused-pipeline variant
// (`verifyLiveFullPipelineReused.spec.ts`) is the deliberate
// exception, since its premise requires the Machine to survive
// across runs.

import {
  createProject,
  type ProjectRow,
} from "@tex-center/db";

import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { expect, test } from "./fixtures/authedPage.js";
import { captureFrames } from "./fixtures/wireFrames.js";
import { expectPreviewCanvasPainted } from "./fixtures/previewCanvas.js";

test.describe("live full pipeline (M8.pw.4)", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveFullPipeline runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await cleanupLiveProjectMachine({
        projectId: seeded.id,
        drizzle: db.db.db,
      });
      seeded = null;
    }
  });

  test("edit → pdf-segment frame → non-blank preview canvas", async ({
    authedPage,
    db,
  }) => {
    // Cold-start of a per-project Machine + first lualatex run
    // dominates. Five minutes is the same budget
    // `verifyLiveWsUpgrade` uses for the same cold start.
    test.setTimeout(300_000);

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw4-${Date.now()}`,
    });
    seeded = project;

    // Collect `pdf-segment` frames via the shared helper. The
    // listener attaches before navigation so the very first frame
    // (which can arrive as soon as the sidecar accepts the WS) is
    // not missed.
    const { pdfSegmentFrames } = captureFrames(authedPage, project.id);

    await authedPage.goto(`/editor/${project.id}`);

    // Wait for the editor's contenteditable to mount. Since iter
    // 177's no-flash fix, `.cm-content` is gated on the first Yjs
    // initial-sync / `file-list` frame arriving from the sidecar,
    // which for a freshly-seeded project requires cold-starting
    // the per-project Fly Machine. 30s was the pre-fix budget
    // (CodeMirror always mounted immediately) and is now too
    // tight — GT-A uses 60s on the same code path. Use the same
    // 120s budget the cold-start TCP-probe path already assumes.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 120_000 });
    await cmContent.click();

    // Minimal compilable LaTeX. CodeMirror's `closeBrackets`
    // extension inserts a matching `}` when `{` is typed and
    // *skips* an inserted `}` if the next char already matches —
    // so typing the source linearly still produces the source
    // unchanged.
    const SRC =
      "\\documentclass{article}\\begin{document}Hello tex.center\\end{document}";
    await authedPage.keyboard.type(SRC, { delay: 5 });

    // Wait for the first PDF_SEGMENT frame to arrive. This is
    // the proof that the whole loop closed.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 240_000,
        message: "no pdf-segment frame received within timeout",
      })
      .toBeGreaterThan(0);

    // The preview pane renders each PDF.js page as a `<canvas>`.
    // Assert the first canvas exists and contains at least one
    // non-near-white pixel via the shared bounded-poll helper
    // (anti-flake primitive landed iter 182 — the `pdf-segment`
    // frame's arrival only proves the bytes reached the page;
    // PDF.js parse + render is async after that).
    await expectPreviewCanvasPainted(authedPage);
  });
});
