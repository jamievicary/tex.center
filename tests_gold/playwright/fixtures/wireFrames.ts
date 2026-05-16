// Shared helper for the live Playwright specs that watch the
// per-project WebSocket frame stream.
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
//
// Iter 352 (`.autodev/PLAN.md` priority #5, see iter-345 discussion):
// every capture also records a `TimelineEntry[]` so the fixture can
// dump a per-spec wire timeline + compile-cycle summary on test
// teardown. Format lives in `wireTimelineFormat.ts` (pure module,
// unit-tested from `tests_normal/cases/wireTimelineFormat.test.mjs`).
// The auto-fixture variant (`captureFramesAuto`) sniffs project IDs
// from the WS URL so it can be attached to every test without an
// explicit projectId argument.

import type { Page } from "@playwright/test";

import {
  formatTimeline,
  type TimelineEntry,
  type TimelineTag,
} from "./wireTimelineFormat.js";

export {
  formatTimeline,
  summariseProject,
  type ProjectSummary,
  type TimelineEntry,
  type TimelineTag,
} from "./wireTimelineFormat.js";

export const TAG_DOC_UPDATE = 0x00;
export const TAG_AWARENESS = 0x01;
export const TAG_CONTROL = 0x10;
export const TAG_PDF_SEGMENT = 0x20;

// Matches the `/ws/project/<uuid>/…` path that the per-project WS
// upgrade uses on both `live` and `local` targets. The capture
// group is the project UUID.
const PROJECT_WS_RE = /\/ws\/project\/([0-9a-f-]{36})/;

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
  /**
   * Render the per-project timeline + summary for this capture.
   * Format is documented in `wireTimelineFormat.ts`.
   */
  dumpTimeline: (specName: string) => string;
}

export interface AutoFrameCapture {
  /** Render the per-project timeline + summary for this capture. */
  dumpTimeline: (specName: string) => string;
  /** Observed project IDs (extracted from WS URL on first open). */
  projectIds: () => string[];
}

interface InternalState {
  entries: TimelineEntry[];
  projectIds: Set<string>;
  startMs: number;
}

function newState(): InternalState {
  return {
    entries: [],
    projectIds: new Set<string>(),
    startMs: Date.now(),
  };
}

interface IncomingDecoded {
  isPdfSegment: boolean;
  isOverlapError: boolean;
  overlapErrorJson?: string;
  compileStatus?: { state: string; detail?: string };
}

function recordIncoming(
  state: InternalState,
  projectId: string,
  payload: Buffer,
): IncomingDecoded {
  const tMs = Date.now() - state.startMs;
  if (payload.length === 0) {
    return { isPdfSegment: false, isOverlapError: false };
  }
  const tag = payload[0]!;
  if (tag === TAG_PDF_SEGMENT) {
    // Header layout: tag(1) + total(4) + offset(4) + segLen(4) + shipoutPage(4)
    let shipoutPage: number | undefined;
    if (payload.length >= 17) {
      const raw = payload.readUInt32BE(13);
      if (raw > 0) shipoutPage = raw;
    }
    const entry: TimelineEntry = {
      tMs,
      dir: "in",
      projectId,
      tag: "pdf-segment",
      bytes: payload.length,
    };
    if (shipoutPage !== undefined) entry.shipoutPage = shipoutPage;
    state.entries.push(entry);
    return { isPdfSegment: true, isOverlapError: false };
  }
  if (tag === TAG_CONTROL) {
    const json = payload.subarray(1).toString("utf8");
    const result: IncomingDecoded = {
      isPdfSegment: false,
      isOverlapError: false,
    };
    let controlType: string | undefined;
    let controlState: string | undefined;
    let controlDetail: string | undefined;
    try {
      const obj = JSON.parse(json) as {
        type?: string;
        state?: string;
        detail?: string;
      };
      if (obj && typeof obj.type === "string") {
        controlType = obj.type;
        if (
          obj.type === "compile-status" &&
          typeof obj.state === "string"
        ) {
          controlState = obj.state;
          if (typeof obj.detail === "string") controlDetail = obj.detail;
          const cs: { state: string; detail?: string } = {
            state: obj.state,
          };
          if (typeof obj.detail === "string") cs.detail = obj.detail;
          result.compileStatus = cs;
        }
      }
    } catch {
      // Non-JSON control payload (shouldn't happen post-protocol
      // v1, but defensive parsing keeps the fixture robust).
    }
    if (json.includes("already in flight")) {
      result.isOverlapError = true;
      result.overlapErrorJson = json;
    }
    const entry: TimelineEntry = {
      tMs,
      dir: "in",
      projectId,
      tag: "control",
      bytes: payload.length,
    };
    if (controlType !== undefined) entry.controlType = controlType;
    if (controlState !== undefined) entry.controlState = controlState;
    if (controlDetail !== undefined) entry.controlDetail = controlDetail;
    state.entries.push(entry);
    return result;
  }
  let kind: TimelineTag = "unknown";
  if (tag === TAG_DOC_UPDATE) kind = "doc-update";
  else if (tag === TAG_AWARENESS) kind = "awareness";
  state.entries.push({
    tMs,
    dir: "in",
    projectId,
    tag: kind,
    bytes: payload.length,
  });
  return { isPdfSegment: false, isOverlapError: false };
}

interface OutgoingDecoded {
  isDocUpdate: boolean;
}

function recordOutgoing(
  state: InternalState,
  projectId: string,
  payload: Buffer,
): OutgoingDecoded {
  const tMs = Date.now() - state.startMs;
  if (payload.length === 0) {
    return { isDocUpdate: false };
  }
  const tag = payload[0]!;
  let kind: TimelineTag = "unknown";
  let controlType: string | undefined;
  if (tag === TAG_DOC_UPDATE) kind = "doc-update";
  else if (tag === TAG_AWARENESS) kind = "awareness";
  else if (tag === TAG_PDF_SEGMENT) kind = "pdf-segment";
  else if (tag === TAG_CONTROL) {
    kind = "control";
    try {
      const obj = JSON.parse(payload.subarray(1).toString("utf8")) as {
        type?: string;
      };
      if (obj && typeof obj.type === "string") controlType = obj.type;
    } catch {
      // Non-JSON control payload.
    }
  }
  const entry: TimelineEntry = {
    tMs,
    dir: "out",
    projectId,
    tag: kind,
    bytes: payload.length,
  };
  if (controlType !== undefined) entry.controlType = controlType;
  state.entries.push(entry);
  return { isDocUpdate: tag === TAG_DOC_UPDATE };
}

interface AttachOpts {
  page: Page;
  state: InternalState;
  match: (url: string) => string | null;
  onIncoming?: (ctx: {
    projectId: string;
    payload: Buffer;
    decoded: IncomingDecoded;
  }) => void;
  onOutgoing?: (ctx: {
    projectId: string;
    payload: Buffer;
    decoded: OutgoingDecoded;
  }) => void;
}

function attachListener(opts: AttachOpts): void {
  const { page, state, match, onIncoming, onOutgoing } = opts;
  page.on("websocket", (ws) => {
    const matched = match(ws.url());
    if (matched === null) return;
    state.projectIds.add(matched);
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") return;
      const decoded = recordIncoming(state, matched, payload);
      if (onIncoming !== undefined) {
        onIncoming({ projectId: matched, payload, decoded });
      }
    });
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string") return;
      const decoded = recordOutgoing(state, matched, payload);
      if (onOutgoing !== undefined) {
        onOutgoing({ projectId: matched, payload, decoded });
      }
    });
  });
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
  const state = newState();
  const pdfSegmentFrames: Buffer[] = [];
  const overlapErrors: string[] = [];
  const docUpdateSent = { value: 0 };
  const compileStatusEvents: { state: string; detail?: string }[] = [];

  attachListener({
    page,
    state,
    match: (url) =>
      url.includes(`/ws/project/${projectId}`) ? projectId : null,
    onIncoming: ({ payload, decoded }) => {
      if (decoded.isPdfSegment) pdfSegmentFrames.push(payload);
      if (decoded.isOverlapError && decoded.overlapErrorJson !== undefined) {
        overlapErrors.push(decoded.overlapErrorJson);
      }
      if (decoded.compileStatus !== undefined) {
        compileStatusEvents.push(decoded.compileStatus);
      }
    },
    onOutgoing: ({ decoded }) => {
      if (decoded.isDocUpdate) docUpdateSent.value += 1;
    },
  });

  return {
    pdfSegmentFrames,
    overlapErrors,
    docUpdateSent,
    compileStatusEvents,
    dumpTimeline: (specName) =>
      formatTimeline({
        specName,
        entries: state.entries,
        projectIds: [...state.projectIds],
      }),
  };
}

/**
 * Auto-bind variant: attach a `framereceived`/`framesent` listener
 * that buckets per-project, extracting the project UUID lazily from
 * the WS URL the first time it sees a matching open. Used by the
 * `authedPage` fixture so every test gets a timeline-on-teardown
 * without naming a projectId up front.
 */
export function captureFramesAuto(page: Page): AutoFrameCapture {
  const state = newState();
  attachListener({
    page,
    state,
    match: (url) => {
      const m = url.match(PROJECT_WS_RE);
      return m === null ? null : m[1]!;
    },
  });
  return {
    dumpTimeline: (specName) =>
      formatTimeline({
        specName,
        entries: state.entries,
        projectIds: [...state.projectIds],
      }),
    projectIds: () => [...state.projectIds],
  };
}
