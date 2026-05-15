// M8.pw.4 reused-project variant — FREEZE-lift criterion (b) per
// `162_answer.md`.
//
// The sibling spec `verifyLiveFullPipeline.spec.ts` seeds a *fresh*
// project in `beforeEach`, exercising the cold-create code path
// (`createProject` → first `upstreamResolver` resolve → fresh
// per-project Fly Machine → first compile on an empty workspace).
// Real users mostly don't do that: they open the same project they
// were editing yesterday. Iter 162's user report showed that
// edit→preview can be broken on the reused path while the
// seeded-fresh path is fine — the two lifecycles differ in
// `upstreamResolver` (existing `machine_assignments` row vs. new
// insert), in the sidecar's `persistence.ts` (existing main.tex
// blob vs. seed-on-first-compile), and potentially in Machine
// memory pressure (long-running Machine vs. cold start).
//
// This spec covers the reused path:
//
//   - A single fixed-UUID project owned by the live test user is
//     idempotently inserted on first run and **never deleted**. It
//     persists across iterations; subsequent runs reuse it.
//   - The per-project Machine is also left running — no
//     `cleanupProjectMachine` call. It will idle-stop on its own,
//     and the next iteration exercises whatever lifecycle Fly is
//     actually in at that moment (stopped/cold-starting/running),
//     which is exactly the heterogeneity real users hit.
//   - The editor is opened (`goto /editor/<fixed-uuid>`) without
//     ever calling `createProject` for this id.
//   - Before typing, Ctrl+A + Backspace clears whatever
//     accumulated source remains in the Y.Doc from prior
//     iterations, then a known-compilable LaTeX source is typed.
//     Without the clear step the doc grows unbounded across runs
//     and eventually stops being valid LaTeX.
//   - The assertion is identical to the fresh-project spec: a
//     `pdf-segment` (tag 0x20) binary frame must arrive on the
//     per-project WS within the same 240s budget, and the first
//     PDF.js canvas in the preview pane must contain at least one
//     non-near-white pixel.
//
// Live-only and gated on `TEXCENTER_FULL_PIPELINE=1` to match
// `verifyLiveFullPipeline.spec.ts`.

import {
  projects,
  type ProjectRow,
} from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { captureFrames } from "./fixtures/wireFrames.js";
import { expectPreviewCanvasPainted } from "./fixtures/previewCanvas.js";

// Fixed v4 UUID. The all-zero prefix makes it instantly
// distinguishable from real user projects in logs and in the DB.
// Owned by the live test user (`TEXCENTER_LIVE_USER_ID`), inserted
// on demand, and intentionally not removed.
const REUSED_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const REUSED_PROJECT_NAME = "pw4-reused-fixture";

test.describe("live full pipeline reused (M8.pw.4 reused project)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveFullPipelineReused runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("reused project: edit → pdf-segment frame → non-blank preview canvas", async ({
    authedPage,
    db,
  }) => {
    // Budget: variance-prone — observed 2.3 s on the warm path
    // (iter 302), but a previously-stopped Machine triggers a cold
    // start that takes ~60-90 s. 150 s = 1.5× the cold-path upper
    // bound; if the warm path consistently dominates this can be
    // tightened.
    test.setTimeout(150_000);

    // Idempotent seed. If a previous iteration already created the
    // row, ON CONFLICT DO NOTHING leaves it untouched (including
    // its `created_at`, so the row really is "old").
    const inserted: ProjectRow[] = await db.db.db
      .insert(projects)
      .values({
        id: REUSED_PROJECT_ID,
        ownerId: db.userId,
        name: REUSED_PROJECT_NAME,
      })
      .onConflictDoNothing()
      .returning();
    // `inserted` is empty when the row was already there — that's
    // the steady-state path and is fine. We assert the row exists
    // regardless so a wrong-owner / table-shape regression fails
    // loud rather than producing an empty editor.
    const visible = await db.db.db.query.projects.findFirst({
      where: (p, { eq, and }) =>
        and(eq(p.id, REUSED_PROJECT_ID), eq(p.ownerId, db.userId)),
    });
    expect(
      visible,
      `reused fixture project ${REUSED_PROJECT_ID} not visible to ` +
        `live user ${db.userId} after upsert (insert returned ` +
        `${inserted.length} rows)`,
    ).toBeTruthy();

    const projectId = REUSED_PROJECT_ID;

    const { pdfSegmentFrames } = captureFrames(authedPage, projectId);

    await authedPage.goto(`/editor/${projectId}`);

    // 120s, matching `verifyLiveFullPipeline.spec.ts`. The reused
    // path can need to cold-start an idle-stopped per-project
    // Machine before the first Yjs sync gates `.cm-content` visible
    // (iter 177's no-flash fix). 30s was tight enough that iter 252
    // saw a TimeoutError here even though the rest of the budget
    // remained.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 120_000 });
    await cmContent.click();

    // The Y.Doc carries whatever source the previous iteration
    // typed. Select-all + Backspace gives us a clean buffer to
    // type into so each run produces the same final source —
    // without it the doc accumulates concatenated LaTeX runs and
    // eventually stops compiling. Two Backspaces: CodeMirror's
    // selection model occasionally swallows the first delete on
    // an empty selection edge case after a click; the second is a
    // no-op when the buffer is already empty.
    await authedPage.keyboard.press("Control+a");
    await authedPage.keyboard.press("Backspace");

    const SRC =
      "\\documentclass{article}\\begin{document}Hello tex.center reused\\end{document}";
    await authedPage.keyboard.type(SRC, { delay: 5 });

    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 240_000,
        message:
          "no pdf-segment frame received within timeout (reused project)",
      })
      .toBeGreaterThan(0);

    // Bounded canvas-painted poll via the shared helper — iter 181
    // surfaced the flake on the reused/warm path where the frame
    // arrived immediately and a single-shot canvas snapshot was
    // still blank. Iter 182 fixed it; iter 183 moved the primitive
    // to `fixtures/previewCanvas.ts`.
    await expectPreviewCanvasPainted(authedPage, {
      message:
        "reused-project preview canvas had no non-near-white pixel " +
        "within timeout — PDF rendered blank or canvas tainted",
    });
  });
});
