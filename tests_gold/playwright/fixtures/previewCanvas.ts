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
import { createHash } from "node:crypto";

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

// Capture a stable SHA-256 fingerprint of the first preview
// canvas's pixel buffer. Used by GT-5 (`verifyLiveGt5*`) to assert
// the rendered preview actually changes after a source edit —
// catching the iter-188 regression class where pdf-segment frames
// arrive but the canvas re-renders to byte-identical bytes.
//
// Returns `null` if the canvas is missing or its pixel buffer is
// not readable yet (width/height 0, getImageData throws, etc).
// Callers poll this rather than treating a single null as fatal.
export async function snapshotPreviewCanvasHash(
  page: Page,
): Promise<string | null> {
  const b64 = await page
    .locator(".preview canvas")
    .first()
    .evaluate((el: Element) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      if (c.width === 0 || c.height === 0) return null;
      try {
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        let binary = "";
        const len = data.length;
        for (let i = 0; i < len; i++) binary += String.fromCharCode(data[i]!);
        return btoa(binary);
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (b64 === null) return null;
  return createHash("sha256").update(b64, "base64").digest("hex");
}

export interface ExpectPreviewCanvasChangedOptions {
  /** Overall poll deadline. Defaults to 60s. */
  timeoutMs?: number;
  /** Custom message on timeout. */
  message?: string;
}

/**
 * Bounded-poll assertion that the first preview canvas's pixel
 * hash has diverged from `priorHash`. The poll re-snapshots each
 * tick (re-locating the canvas), tolerating mid-render frames
 * where `getImageData` momentarily fails. Strict byte-exact
 * mismatch — see `188_answer.md` for the strict-vs-perceptual
 * decision.
 */
export async function expectPreviewCanvasChanged(
  page: Page,
  priorHash: string,
  options: ExpectPreviewCanvasChangedOptions = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 60_000;
  const message =
    options.message ??
    "preview canvas hash did not diverge from the pre-edit snapshot " +
      "within timeout — pdf-segment frames may be arriving with " +
      "byte-identical bytes (iter-188 regression class)";

  await expect
    .poll(
      async () => {
        const h = await snapshotPreviewCanvasHash(page);
        if (h === null) return false;
        return h !== priorHash;
      },
      { timeout, message },
    )
    .toBe(true);
}
