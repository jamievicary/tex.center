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
// The fresh project row is deleted in `afterEach`; the
// per-project Machine is left running and will idle-stop itself.
// (`cleanupProjectMachine` is intentionally NOT called — proving
// the wake/idle-stop cycle is a separate verification, owned by
// `verifyLiveWsUpgrade`.)

import { eq } from "drizzle-orm";

import {
  createProject,
  projects,
  type ProjectRow,
} from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

// `@tex-center/protocol` is not in the root workspace devDeps that
// Playwright's transform sees — inline the single constant we need
// rather than wire a fresh dependency just for this. The wire
// format guarantees this byte is the `pdf-segment` frame tag (see
// `packages/protocol/src/index.ts:TAG_PDF_SEGMENT`).
const TAG_PDF_SEGMENT = 0x20;

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
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
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

    // Collect `pdf-segment` frames as they stream in. The
    // listener must be attached before navigation so we don't
    // miss the very first one. Playwright's `framereceived`
    // payload is a `Buffer` (binary frame) or `string` (text
    // frame); we only care about binary frames whose first byte
    // is the PDF_SEGMENT tag.
    const pdfSegmentFrames: Buffer[] = [];
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${project.id}`)) return;
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) {
          pdfSegmentFrames.push(payload);
        }
      });
    });

    await authedPage.goto(`/editor/${project.id}`);

    // Wait for the editor's contenteditable to mount.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 30_000 });
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
    // non-near-white pixel.
    const canvas = authedPage.locator(".preview canvas").first();
    await canvas.waitFor({ state: "attached", timeout: 30_000 });

    const nonBlank = await canvas.evaluate((el: Element) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const a = data[i + 3]!;
        if (a === 0) continue;
        if (r < 240 || g < 240 || b < 240) return true;
      }
      return false;
    });
    expect(
      nonBlank,
      "preview canvas had no non-near-white pixel — PDF rendered blank or canvas tainted",
    ).toBe(true);
  });
});
