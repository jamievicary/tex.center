// Pure logic for picking the page indices the PDF preview pane uses
// to drive the `viewing-page` wire signal. Fed by IntersectionObserver
// entries (or any other source of per-page visibility ratios). Kept
// DOM-free so it can be unit-tested under tsx.
//
// Two picks are exposed:
// - `pickMostVisible`: page with highest visibility ratio (lower
//   page wins on tie). Diagnostic; not used on the wire post-M21.
//   Strict `ratio > 0` predicate — any non-zero sliver counts so
//   the dominant page is always discoverable even when the viewport
//   is between pages.
// - `pickMaxVisible`: highest page index with ratio above
//   `MAX_VISIBLE_RATIO_THRESHOLD` (default 0.1). This is the
//   compile-pacing signal: a 1-pixel sliver of page N+1 below the
//   fold should not promote the wire `maxViewingPage` to N+1 (that
//   was the off-by-one user-reported on iter 309 / M21.3a).

export interface PageVisibility {
  page: number;
  ratio: number;
}

// Minimum intersectionRatio for a page to count as "visible" for
// max-visible / compile-pacing purposes. Below this, the page is
// considered an accidental sliver (e.g. the top edge of the page
// after the last fully-visible one). Exported so call sites and
// tests can reference the load-bearing value by name.
export const MAX_VISIBLE_RATIO_THRESHOLD = 0.1;

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

export function pickMaxVisible(
  items: Iterable<PageVisibility>,
  minRatio: number = MAX_VISIBLE_RATIO_THRESHOLD,
): number | null {
  let max: number | null = null;
  for (const it of items) {
    if (it.ratio <= minRatio) continue;
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
