// Pure logic for picking the page indices the PDF preview pane uses
// to drive the `viewing-page` wire signal. Fed by IntersectionObserver
// entries (or any other source of per-page visibility ratios). Kept
// DOM-free so it can be unit-tested under tsx.
//
// Two picks are exposed:
// - `pickMostVisible`: page with highest visibility ratio (lower
//   page wins on tie). Diagnostic; not used on the wire post-M21.
// - `pickMaxVisible`: highest page index with any non-zero ratio.
//   This is what the editor sends to the sidecar so every page the
//   user can see — including one whose top edge intrudes from below
//   the fold — is in scope for compilation.
//
// Pages with ratio <= 0 are treated as not visible by both picks.

export interface PageVisibility {
  page: number;
  ratio: number;
}

export function pickMostVisible(items: Iterable<PageVisibility>): number | null {
  let best: PageVisibility | null = null;
  for (const it of items) {
    if (it.ratio <= 0) continue;
    if (
      best === null ||
      it.ratio > best.ratio ||
      (it.ratio === best.ratio && it.page < best.page)
    ) {
      best = it;
    }
  }
  return best ? best.page : null;
}

export function pickMaxVisible(items: Iterable<PageVisibility>): number | null {
  let max: number | null = null;
  for (const it of items) {
    if (it.ratio <= 0) continue;
    if (max === null || it.page > max) max = it.page;
  }
  return max;
}

// Maintains a page→ratio map and reports per-call transitions in
// both the most-visible and max-visible picks. Construct one per
// PdfViewer instance; feed it IO entries via `update`. A `null`
// member of the return value means "no transition this call"; the
// last-known value is preserved when an update would otherwise drop
// it to null (matches the M17/M21 pre-rename behaviour and keeps the
// IO-driven callback path stable across momentary empty frames).
export class PageTracker {
  private readonly ratios = new Map<number, number>();
  private currentMost: number | null = null;
  private currentMax: number | null = null;

  reset(): void {
    this.ratios.clear();
    this.currentMost = null;
    this.currentMax = null;
  }

  update(
    page: number,
    ratio: number,
  ): { mostVisible: number | null; maxVisible: number | null } {
    this.ratios.set(page, ratio);
    const items: PageVisibility[] = [];
    for (const [p, r] of this.ratios) items.push({ page: p, ratio: r });
    const nextMost = pickMostVisible(items);
    const nextMax = pickMaxVisible(items);
    let mostVisible: number | null = null;
    let maxVisible: number | null = null;
    if (nextMost !== null && nextMost !== this.currentMost) {
      this.currentMost = nextMost;
      mostVisible = nextMost;
    }
    if (nextMax !== null && nextMax !== this.currentMax) {
      this.currentMax = nextMax;
      maxVisible = nextMax;
    }
    return { mostVisible, maxVisible };
  }

  get visible(): number | null {
    return this.currentMost;
  }

  get mostVisible(): number | null {
    return this.currentMost;
  }

  get maxVisible(): number | null {
    return this.currentMax;
  }
}
