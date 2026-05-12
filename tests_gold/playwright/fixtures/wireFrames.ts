// Shared helper for the five live Playwright specs that need to
// watch the per-project WebSocket frame stream.
//
// Each spec used to redeclare:
//   - `TAG_PDF_SEGMENT = 0x20` (and GT-C/D also `TAG_CONTROL = 0x10`)
//   - an inline `page.on("websocket", ...)` + `framereceived`
//     handler filtering by `/ws/project/${projectId}` and bucketing
//     payloads into `pdfSegmentFrames` and (GT-C/D) `overlapErrors`.
//
// The tag constants are duplicated from
// `packages/protocol/src/index.ts` deliberately — Playwright's
// transform path doesn't have `@tex-center/protocol` in its
// devDeps, and wiring it would be heavier than re-stating two
// bytes. Authoritative definition lives in the protocol package.

import type { Page } from "@playwright/test";

export const TAG_CONTROL = 0x10;
export const TAG_PDF_SEGMENT = 0x20;

export interface FrameCapture {
  /** All TAG_PDF_SEGMENT (0x20) binary frames, in arrival order. */
  pdfSegmentFrames: Buffer[];
  /**
   * Sidecar `compile-status state:error` control-frame payloads
   * whose JSON contains the "already in flight" sentinel. Captured
   * separately so GT-C/D can assert the overlap-error array is
   * empty even when the pdf-segment count is fine.
   */
  overlapErrors: string[];
}

/**
 * Attach a `framereceived` listener to the per-project WS for
 * `projectId` and collect pdf-segment frames + overlap-error
 * control frames into live arrays. Must be called BEFORE
 * navigating to `/editor/<projectId>` so the first frame is not
 * missed (the listener runs on every websocket the page opens; we
 * filter by URL inside the handler).
 *
 * Control-frame parsing intentionally avoids `decodeFrame` from
 * `@tex-center/protocol` (same devDeps story as the tag constants)
 * — we only need to detect a sentinel substring in the JSON tail.
 */
export function captureFrames(page: Page, projectId: string): FrameCapture {
  const pdfSegmentFrames: Buffer[] = [];
  const overlapErrors: string[] = [];

  page.on("websocket", (ws) => {
    if (!ws.url().includes(`/ws/project/${projectId}`)) return;
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") return;
      if (payload.length === 0) return;
      if (payload[0] === TAG_PDF_SEGMENT) {
        pdfSegmentFrames.push(payload);
        return;
      }
      if (payload[0] === TAG_CONTROL) {
        const json = payload.subarray(1).toString("utf8");
        if (json.includes("already in flight")) {
          overlapErrors.push(json);
        }
      }
    });
  });

  return { pdfSegmentFrames, overlapErrors };
}
