// Bounded-poll assertion that the preview pane's first PDF.js
// canvas is painted with at least one non-near-white pixel.
//
// Iter 181 surfaced that a single-shot `canvas.evaluate(nonBlank)`
// after the `pdf-segment` frame arrives races PDF.js's async
// parse + paint — the frame's bytes reached the page but the
// canvas was still blank when sampled. Iter 182 replaced the
// single-shot reads in `verifyLiveFullPipeline*.spec.ts` with a
// 30s bounded poll re-locating `.preview canvas` each tick (to
// survive an incremental re-render replacing the element) and
// swallowing per-tick evaluate errors. This helper consolidates
// that shape so every spec that asserts the preview painted uses
// the same anti-flake primitive.

import { expect, type Page } from "@playwright/test";

export interface ExpectPreviewCanvasPaintedOptions {
  /** Overall poll deadline. Defaults to 30s — same as iter 182's bump. */
  timeoutMs?: number;
  /** Custom message on timeout. Default explains the race. */
  message?: string;
}

export async function expectPreviewCanvasPainted(
  page: Page,
  options: ExpectPreviewCanvasPaintedOptions = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 30_000;
  const message =
    options.message ??
    "preview canvas had no non-near-white pixel within timeout — " +
      "PDF rendered blank or canvas tainted";

  const canvas = page.locator(".preview canvas").first();
  await canvas.waitFor({ state: "attached", timeout });

  await expect
    .poll(
      async () => {
        return await page
          .locator(".preview canvas")
          .first()
          .evaluate((el: Element) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext("2d");
            if (!ctx) return false;
            if (c.width === 0 || c.height === 0) return false;
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
          })
          .catch(() => false);
      },
      { timeout, message },
    )
    .toBe(true);
}
