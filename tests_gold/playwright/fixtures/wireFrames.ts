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

export const TAG_DOC_UPDATE = 0x00;
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
  /**
   * Running count of outgoing TAG_DOC_UPDATE (0x00) frames on the
   * project WS — i.e. Yjs ops the client sent toward the sidecar.
   * Read live (not snapshotted). Lets specs distinguish
   * "typing-didn't-reach-WS" from "WS-fine-but-no-compile-segment"
   * failure modes; introduced iter 274 for the
   * `verifyLivePdfMultiPage` post-edit-segment diagnosis.
   */
  readonly docUpdateSent: { value: number };
  /**
   * All sidecar `compile-status` control frames received on the
   * project WS, in arrival order. Each entry is the parsed JSON
   * payload (`{ type: "compile-status", state, detail? }`).
   * Introduced iter 275 to distinguish post-typing failure modes
   * in `verifyLivePdfMultiPage` once the iter-274 client-side
   * diagnostic ruled out "typing didn't reach the WS":
   *
   *   - empty array → sidecar's coalescer never fired a compile
   *     after the edits;
   *   - `running` then `error` → compile reached the daemon and
   *     failed (detail surfaces the daemon error);
   *   - `running` then `idle` but no pdf-segment → compile
   *     succeeded but emitted no segment (sidecar-layer bug).
   */
  compileStatusEvents: { state: string; detail?: string }[];
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
  const docUpdateSent = { value: 0 };
  const compileStatusEvents: { state: string; detail?: string }[] = [];

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
        try {
          const obj = JSON.parse(json) as {
            type?: string;
            state?: string;
            detail?: string;
          };
          if (
            obj &&
            obj.type === "compile-status" &&
            typeof obj.state === "string"
          ) {
            const entry: { state: string; detail?: string } = {
              state: obj.state,
            };
            if (typeof obj.detail === "string") entry.detail = obj.detail;
            compileStatusEvents.push(entry);
          }
        } catch {
          // Non-JSON control payload (shouldn't happen post-protocol
          // v1, but defensive parsing keeps the fixture robust).
        }
      }
    });
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string") return;
      if (payload.length === 0) return;
      if (payload[0] === TAG_DOC_UPDATE) {
        docUpdateSent.value += 1;
      }
    });
  });

  return {
    pdfSegmentFrames,
    overlapErrors,
    docUpdateSent,
    compileStatusEvents,
  };
}
