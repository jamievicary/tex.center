// Polls a PDF file's (size, mtime) and resolves once the value
// has been unchanged for a configurable window. Used to decide
// when a compiler has finished writing its output, in the absence
// of an upstream end-of-round signal.
//
// Today nothing calls this — the `SupertexOnceCompiler` path
// returns after the engine exits, by which point the PDF is
// already on disk. The watcher exists ready for the streaming
// (`--daemon DIR`) consumer that will return from `compile()`
// before the PDF settles; at that point a thin wrapper above the
// compiler will `await awaitPdfStable(...)` before shipping bytes.

import { stat } from "node:fs/promises";

export interface PdfStat {
  size: number;
  mtimeMs: number;
}

export type PdfStatFn = (path: string) => Promise<PdfStat | null>;
export type NowFn = () => number;
export type SleepFn = (ms: number) => Promise<void>;

export interface AwaitPdfStableOptions {
  /** Min duration the (size, mtime) tuple must stay unchanged. Default 200 ms. */
  windowMs?: number;
  /** Polling cadence. Default 50 ms. */
  cadenceMs?: number;
  /** Hard upper bound from first call to resolve. Default 5_000 ms. */
  ceilingMs?: number;
  /** Test seam: stat replacement. Default `fs/promises.stat`. */
  statFn?: PdfStatFn;
  /** Test seam: clock. Default `Date.now`. */
  nowFn?: NowFn;
  /** Test seam: sleep. Default `setTimeout`-based. */
  sleepFn?: SleepFn;
}

export type AwaitPdfStableResult =
  | { state: "stable"; size: number; mtimeMs: number }
  | { state: "ceiling"; size: number | null; mtimeMs: number | null }
  | { state: "missing" };

const defaultStat: PdfStatFn = async (path) => {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the PDF at `path` looks settled. Resolves to
 * `{state: "stable"}` once two consecutive samples taken `windowMs`
 * apart agree on `(size, mtimeMs)`; resolves to `{state: "ceiling"}`
 * if the deadline fires first; resolves to `{state: "missing"}` if
 * the file never appears before the deadline.
 *
 * The watcher never throws on a non-ENOENT stat error — it surfaces
 * unexpected errors by rejecting (caller can decide to retry or
 * give up).
 */
export async function awaitPdfStable(
  path: string,
  opts: AwaitPdfStableOptions = {},
): Promise<AwaitPdfStableResult> {
  const windowMs = opts.windowMs ?? 200;
  const cadenceMs = opts.cadenceMs ?? 50;
  const ceilingMs = opts.ceilingMs ?? 5_000;
  const statFn = opts.statFn ?? defaultStat;
  const nowFn = opts.nowFn ?? Date.now;
  const sleepFn = opts.sleepFn ?? defaultSleep;

  const start = nowFn();
  let lastStat: PdfStat | null = null;
  let lastChangeAt = start;

  while (true) {
    const cur = await statFn(path);
    const now = nowFn();
    if (cur === null) {
      lastStat = null;
      lastChangeAt = now;
    } else {
      if (lastStat === null || cur.size !== lastStat.size || cur.mtimeMs !== lastStat.mtimeMs) {
        lastStat = cur;
        lastChangeAt = now;
      } else if (now - lastChangeAt >= windowMs) {
        return { state: "stable", size: cur.size, mtimeMs: cur.mtimeMs };
      }
    }
    if (now - start >= ceilingMs) {
      if (lastStat === null) return { state: "missing" };
      return { state: "ceiling", size: lastStat.size, mtimeMs: lastStat.mtimeMs };
    }
    await sleepFn(cadenceMs);
  }
}
