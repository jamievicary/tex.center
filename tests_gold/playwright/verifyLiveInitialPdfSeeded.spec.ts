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

import { eq } from "drizzle-orm";

import {
  createProject,
  projects,
  type ProjectRow,
} from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

const TAG_PDF_SEGMENT = 0x20;

test.describe("live initial PDF for seeded content (GT-B)", () => {
  let seeded: ProjectRow | null = null;

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

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("seeded project: pdf-segment arrives without user input", async ({
    authedPage,
    db,
  }) => {
    test.setTimeout(300_000);

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-initialpdf-${Date.now()}`,
    });
    seeded = project;

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
      "seeded-template preview canvas had no non-near-white pixel",
    ).toBe(true);
  });
});
