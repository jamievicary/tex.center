// Per-project PDF segmenter, driven by supertex's `--live-shipouts`
// page→PDF-offset log. State is carried across compiles (one
// segmenter per project, owned by the watch compiler).
//
// Contract with `--live-shipouts`: an append-only file. Each line is
// `<page>\t<offset>` written by supertex when a shipout completes,
// where `offset` is the byte offset in the PDF at which that
// shipout begins. On a rollback, supertex re-emits affected pages
// with new offsets — those are simply more append lines.
//
// Per compile, the lines added since the last read position ARE the
// set of shipouts re-emitted this round, and therefore the set of
// PDF byte-ranges the client doesn't yet have. We emit one
// `pdf-segment` per such line. The next-offset of each segment is
// looked up in the *full* current per-page offset map (latest entry
// per page wins, plus stale-pages-past-EOF dropped) so segments
// cover exactly to the next shipout boundary, or PDF EOF for the
// final shipout.
//
// First compile / no shipouts file: emit one whole-PDF segment.
// (Initial state of a new project; or running against a build of
// supertex that doesn't write shipouts yet.)
//
// Limitations of the M3.4 minimum:
//   - If pages are dropped (PDF shrank past a prior page's offset)
//     but its prior offset is still < new totalLength, the stale
//     entry survives in the offset map until that page is re-shipped.
//     The fix is for supertex to emit a "round-end / now-N-pages"
//     hint; tracked under M3.5 alongside the READY marker.
//   - Segmentation is purely append-driven; pre-existing pages whose
//     offsets shifted (because earlier content grew) but were not
//     re-shipped in this round will desynchronise the client. In
//     practice supertex's rollback model means earlier-page changes
//     trigger re-emission of all later pages, so this should not
//     occur.

import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import type { PdfSegment } from "./types.js";

export interface ShipoutEntry {
  page: number;
  offset: number;
}

export function parseShipoutLines(text: string): ShipoutEntry[] {
  const out: ShipoutEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const page = Number.parseInt(line.slice(0, tab), 10);
    const offset = Number.parseInt(line.slice(tab + 1), 10);
    if (!Number.isFinite(page) || !Number.isFinite(offset)) continue;
    if (page < 0 || offset < 0) continue;
    out.push({ page, offset });
  }
  return out;
}

export class ShipoutSegmenter {
  private readonly shipoutsPath: string;
  private readPos = 0;
  private readonly pageOffsets = new Map<number, number>();

  constructor(shipoutsPath: string) {
    this.shipoutsPath = shipoutsPath;
  }

  /**
   * Read new shipouts entries since the previous call, fold them
   * into the per-page offset map, and return one `PdfSegment` per
   * round entry. If no shipouts file exists or no new entries are
   * present on the first call, returns a single whole-PDF segment.
   */
  async update(pdfBytes: Uint8Array): Promise<PdfSegment[]> {
    const totalLength = pdfBytes.length;
    const newEntries = await this.readDelta();

    // Fold new entries into the running map (latest entry per page
    // wins). Then drop pages whose offset is past current EOF.
    for (const e of newEntries) {
      this.pageOffsets.set(e.page, e.offset);
    }
    for (const [page, offset] of this.pageOffsets) {
      if (offset >= totalLength) this.pageOffsets.delete(page);
    }

    // No information from the shipouts file yet — fall back to a
    // single whole-PDF segment so the client at least gets the bytes.
    if (newEntries.length === 0 && this.pageOffsets.size === 0) {
      if (totalLength === 0) return [];
      return [{ totalLength, offset: 0, bytes: pdfBytes }];
    }

    // Sort all known shipouts by offset to derive boundary lookup.
    const sortedOffsets = Array.from(new Set(this.pageOffsets.values())).sort(
      (a, b) => a - b,
    );

    function nextBoundary(offset: number): number {
      // Binary search for the smallest offset > `offset`; if none,
      // PDF EOF is the upper bound.
      let lo = 0;
      let hi = sortedOffsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedOffsets[mid]! <= offset) lo = mid + 1;
        else hi = mid;
      }
      return lo < sortedOffsets.length ? sortedOffsets[lo]! : totalLength;
    }

    // Emit one segment per round entry, in the order they were
    // appended (which matches supertex's emission order).
    const segments: PdfSegment[] = [];
    for (const e of newEntries) {
      // Skip entries that the post-fold drop step culled.
      if (this.pageOffsets.get(e.page) !== e.offset) continue;
      const end = nextBoundary(e.offset);
      const safeEnd = Math.min(end, totalLength);
      if (safeEnd <= e.offset) continue;
      segments.push({
        totalLength,
        offset: e.offset,
        bytes: pdfBytes.subarray(e.offset, safeEnd),
      });
    }
    return segments;
  }

  private async readDelta(): Promise<ShipoutEntry[]> {
    let fh: FileHandle;
    try {
      fh = await fsOpen(this.shipoutsPath, fsConstants.O_RDONLY);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw e;
    }
    try {
      const stat = await fh.stat();
      if (stat.size < this.readPos) {
        // File got shorter (e.g. supertex restarted and truncated).
        this.readPos = 0;
      }
      if (stat.size === this.readPos) return [];
      const len = stat.size - this.readPos;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.readPos);
      this.readPos = stat.size;
      return parseShipoutLines(buf.toString("utf8"));
    } finally {
      await fh.close();
    }
  }
}
