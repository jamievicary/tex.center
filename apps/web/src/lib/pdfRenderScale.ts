// Compute the two render scales used by PdfViewer (M18).
//
// `cssScale` is the scale we want the page to occupy in CSS pixels —
// it determines the wrapper's intrinsic width/height and so feeds
// layout. `pixelScale` is the scale we render at — it determines the
// canvas backing-store resolution. On a HiDPI display the canvas
// needs `cssScale * devicePixelRatio` backing pixels for every CSS
// pixel of display, otherwise the browser stretches a smaller
// bitmap to fit and the preview looks pixelated.
//
// A non-finite or non-positive `dpr` (e.g. headless contexts that
// report 0) falls back to 1 — at worst the render is a touch coarser
// than ideal, never crashing.

export interface PdfRenderScale {
  readonly cssScale: number;
  readonly pixelScale: number;
}

export function pdfRenderScale(
  baseScale: number,
  dpr: number,
): PdfRenderScale {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { cssScale: baseScale, pixelScale: baseScale * safeDpr };
}
