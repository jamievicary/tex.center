// Pure data types + formatter for the per-spec WS-frame timeline
// diagnostic (priority #5 of `.autodev/PLAN.md`; iter-346 discussion
// commit). No Playwright imports — kept side-effect-free so the
// formatter is unit-testable from a plain Node script (the unit test
// lives in `tests_normal/cases/wireTimelineFormat.test.mjs`).
//
// Consumed by `wireFrames.ts` (which feeds frame events from the
// Playwright `Page` into `TimelineEntry[]`) and by the `authedPage`
// fixture's `afterEach`-style dump path. The output format is
// deliberately compact + grep-friendly: a `zero-segment-cycles>0`
// summary line is the signal that pins the "compile cycle ran but
// shipped no pdf-segment" failure shape (Bug B, see
// `.autodev/discussion/344_question.md` and 345_answer.md §B).

export type TimelineTag =
  | "doc-update"
  | "awareness"
  | "control"
  | "pdf-segment"
  | "unknown";

export interface TimelineEntry {
  /** Milliseconds since the collector started. */
  tMs: number;
  dir: "in" | "out";
  /** Project UUID extracted from the WS URL. */
  projectId: string;
  tag: TimelineTag;
  /** Total frame byte length, including the tag byte. */
  bytes: number;
  /** Parsed `type` field for control frames (e.g. "compile-status"). */
  controlType?: string;
  /** For `compile-status` only: the `state` field. */
  controlState?: string;
  /**
   * For `compile-status state=error` only: the sidecar's `detail`
   * field carrying the underlying compile error (typically
   * `"supertex daemon error: <reason>"`,
   * `"supertex-daemon: another compile already in flight"`, or
   * the workspace-write exception string). Surfaced in the
   * timeline line so a failing gold spec pins the error class
   * without a separate sidecar-log lookup — see iter 358 log.
   */
  controlDetail?: string;
  /** For pdf-segment only: the `shipoutPage` field (0 sentinel omitted). */
  shipoutPage?: number;
}

export interface ProjectSummary {
  inCounts: Record<string, number>;
  outCounts: Record<string, number>;
  pdfSegmentBytes: number;
  docUpdateBytes: number;
  compileCycles: number;
  zeroSegmentCycles: number;
  meanCycleMs: number | null;
}

/**
 * Per-project derived stats. A "compile cycle" is the interval
 * between a `compile-status state=running` event and the next
 * `idle`/`error` event on the same WS. Within a cycle, count
 * incoming `pdf-segment` arrivals; a cycle that closes without one
 * is a `zero-segment-cycle` — the exact shape that pins Bug B
 * (compile reached the daemon, no patch shipped).
 *
 * Edge cases:
 *  - Back-to-back `running` events (no intervening `idle`/`error`):
 *    close the open cycle at the second `running` with its own
 *    segment count. This avoids losing cycles when the sidecar
 *    coalesces overlapping recompiles.
 *  - An unclosed cycle at end-of-test is silently dropped — it is
 *    not yet known whether it would have shipped a segment.
 */
export function summariseProject(
  entries: readonly TimelineEntry[],
): ProjectSummary {
  const inCounts: Record<string, number> = {};
  const outCounts: Record<string, number> = {};
  let pdfSegmentBytes = 0;
  let docUpdateBytes = 0;

  const cycleLengths: number[] = [];
  let cycleCount = 0;
  let zeroSegmentCycles = 0;
  let openCycleStartMs: number | null = null;
  let openCycleSegments = 0;

  const bump = (bag: Record<string, number>, key: string): void => {
    bag[key] = (bag[key] ?? 0) + 1;
  };

  const closeCycle = (closeMs: number): void => {
    if (openCycleStartMs === null) return;
    cycleLengths.push(closeMs - openCycleStartMs);
    cycleCount += 1;
    if (openCycleSegments === 0) zeroSegmentCycles += 1;
    openCycleStartMs = null;
    openCycleSegments = 0;
  };

  for (const e of entries) {
    const key =
      e.tag === "control" && e.controlType !== undefined
        ? `control:${e.controlType}`
        : e.tag;
    if (e.dir === "in") {
      bump(inCounts, key);
      if (e.tag === "pdf-segment") {
        pdfSegmentBytes += e.bytes;
        if (openCycleStartMs !== null) openCycleSegments += 1;
      } else if (
        e.tag === "control" &&
        e.controlType === "compile-status"
      ) {
        if (e.controlState === "running") {
          closeCycle(e.tMs);
          openCycleStartMs = e.tMs;
          openCycleSegments = 0;
        } else if (
          e.controlState === "idle" ||
          e.controlState === "error"
        ) {
          closeCycle(e.tMs);
        }
      }
    } else {
      bump(outCounts, key);
      if (e.tag === "doc-update") docUpdateBytes += e.bytes;
    }
  }

  const meanCycleMs =
    cycleLengths.length === 0
      ? null
      : cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length;

  return {
    inCounts,
    outCounts,
    pdfSegmentBytes,
    docUpdateBytes,
    compileCycles: cycleCount,
    zeroSegmentCycles,
    meanCycleMs,
  };
}

function fmtCounts(bag: Record<string, number>): string {
  const keys = Object.keys(bag).sort();
  if (keys.length === 0) return "(none)";
  return keys.map((k) => `${k}×${bag[k]}`).join(", ");
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function entryTerseSummary(e: TimelineEntry): string {
  switch (e.tag) {
    case "pdf-segment":
      return e.shipoutPage !== undefined
        ? `bytes=${e.bytes} shipoutPage=${e.shipoutPage}`
        : `bytes=${e.bytes}`;
    case "doc-update":
    case "awareness":
      return `bytes=${e.bytes}`;
    case "control":
      if (e.controlType === "compile-status") {
        const base = `state=${e.controlState ?? "?"}`;
        if (
          e.controlState === "error" &&
          e.controlDetail !== undefined &&
          e.controlDetail !== ""
        ) {
          return `${base} detail=${e.controlDetail}`;
        }
        return base;
      }
      return e.controlType ?? "(unparsed)";
    default:
      return `bytes=${e.bytes}`;
  }
}

/**
 * Render a one-block-per-project timeline + summary string for a
 * single spec invocation. When no project WS was observed, emits
 * a single uniform line (`"…: no project WS observed"`) so the dump
 * is shape-consistent across the local-target specs that never
 * open one.
 *
 * Project IDs are sorted so the output is deterministic.
 */
export function formatTimeline(opts: {
  specName: string;
  entries: readonly TimelineEntry[];
  projectIds: readonly string[];
}): string {
  const { specName, entries, projectIds } = opts;
  if (projectIds.length === 0) {
    return `[${specName}] timeline: no project WS observed`;
  }
  const lines: string[] = [];
  const sorted = [...projectIds].sort();
  for (const pid of sorted) {
    const pe = entries.filter((e) => e.projectId === pid);
    lines.push(`[${specName}] timeline (project=${pid}):`);
    for (const e of pe) {
      const t = `+${(e.tMs / 1000).toFixed(3)}s`.padStart(9);
      const dir = e.dir.padEnd(3);
      const tagDisplay =
        e.tag === "control" && e.controlType !== undefined
          ? `control:${e.controlType}`
          : e.tag;
      const tag = tagDisplay.padEnd(24);
      lines.push(`  ${t}  ${dir}  ${tag}  ${entryTerseSummary(e)}`);
    }
    const s = summariseProject(pe);
    const meanCycleStr =
      s.meanCycleMs === null ? "n/a" : fmtMs(Math.round(s.meanCycleMs));
    const inExtra =
      `compile-cycles=${s.compileCycles} ` +
      `zero-segment-cycles=${s.zeroSegmentCycles} ` +
      `mean-cycle=${meanCycleStr} ` +
      `pdf-segment-bytes=${s.pdfSegmentBytes}`;
    const outExtra = `doc-update-bytes=${s.docUpdateBytes}`;
    lines.push(
      `[${specName}] summary (project=${pid}): ` +
        `in {${fmtCounts(s.inCounts)}} (${inExtra}), ` +
        `out {${fmtCounts(s.outCounts)}} (${outExtra})`,
    );
  }
  return lines.join("\n");
}
