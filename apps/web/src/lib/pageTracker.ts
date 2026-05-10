// Pure logic for picking the "most visible" page in a multi-page
// PDF preview. Fed by IntersectionObserver entries (or any other
// source of per-page visibility ratios). Kept DOM-free so it can
// be unit-tested under tsx.
//
// Tie-break: highest ratio wins; if equal, the lower page number
// wins. A page with ratio <= 0 is treated as not visible.

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

// Maintains a page→ratio map and reports a new "most visible"
// page only when it actually changes. Construct one per
// PdfViewer instance; feed it IO entries via `update`.
export class PageTracker {
  private readonly ratios = new Map<number, number>();
  private current: number | null = null;

  reset(): void {
    this.ratios.clear();
    this.current = null;
  }

  update(page: number, ratio: number): number | null {
    this.ratios.set(page, ratio);
    const items: PageVisibility[] = [];
    for (const [p, r] of this.ratios) items.push({ page: p, ratio: r });
    const next = pickMostVisible(items);
    if (next !== null && next !== this.current) {
      this.current = next;
      return next;
    }
    return null;
  }

  get visible(): number | null {
    return this.current;
  }
}
