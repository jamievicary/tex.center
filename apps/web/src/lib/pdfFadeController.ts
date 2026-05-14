// Per-page cross-fade controller for the PDF preview pane (M17).
//
// PdfViewer renders all pages off-DOM, then hands the controller a
// freshly-rendered canvas per page. The controller:
//
//   * Maintains one `<div class="pdf-page">` wrapper per page.
//   * On commit, places the new canvas under each wrapper alongside
//     any existing canvas, fades old→new over `fadeMs`.
//   * Adds wrappers fade-in for pages beyond the previous count;
//     removes wrappers fade-out for pages that disappear.
//   * If a new commit arrives mid-fade, snapshots the in-flight
//     transition: removes any old canvas, sets the most-recent
//     canvas opaque, clears the transition class. The next commit
//     then treats that canvas as "old" for its own cross-fade.
//
// The controller installs `data-page` on each wrapper (not the
// canvas) so the IntersectionObserver in PdfViewer can target a
// stable DOM node across renders — no `tracker.reset()` per render.
//
// DOM ops are isolated behind a small adapter interface so the
// state machine can be unit-tested under tsx without jsdom.

export interface PageNode {
  readonly wrapper: unknown;
  // The current "settled" canvas — the one a future commit will
  // animate away from. Null only for a wrapper that has just been
  // created and never seen a canvas (impossible in current flow but
  // tracked defensively).
  current: unknown | null;
  // The canvas currently fading in, or null if no fade is in flight
  // for this page. When set, opacity is transitioning 0→1; `current`
  // refers to the canvas fading out (opacity 1→0).
  entering: unknown | null;
}

export interface FadeAdapter {
  // Returns a new wrapper element appended to the host.
  createWrapper(pageIndex: number): unknown;
  removeWrapper(wrapper: unknown): void;
  appendCanvasToWrapper(wrapper: unknown, canvas: unknown): void;
  removeCanvasFromWrapper(wrapper: unknown, canvas: unknown): void;
  // Geometry: set the wrapper size to match the canvas's intrinsic
  // dimensions so the layout is stable across renders even before
  // the canvas paints.
  setWrapperGeometry(wrapper: unknown, w: number, h: number): void;
  // Apply CSS classes for the cross-fade. The adapter is expected to
  // set initial opacity 0 on the entering canvas synchronously, then
  // — after a forced reflow — apply the "active" class which kicks
  // off the transition to opacity 1 / 0 on the entering/leaving
  // canvases respectively.
  startCrossFade(opts: {
    wrapper: unknown;
    leaving: unknown | null;
    entering: unknown;
  }): void;
  // Cancel any in-flight cross-fade for this wrapper. Removes the
  // `leaving` canvas (if any) and snaps the `entering` canvas to
  // fully opaque. Idempotent.
  commitFadeImmediately(opts: {
    wrapper: unknown;
    leaving: unknown | null;
    entering: unknown | null;
  }): void;
  // Wrapper-level fade for add/remove transitions. `enter` starts
  // the wrapper at opacity 0 then transitions to 1; `exit`
  // transitions 1→0 and removes on completion.
  fadeInWrapper(wrapper: unknown): void;
  fadeOutAndRemoveWrapper(wrapper: unknown): void;
}

export interface CanvasDescriptor {
  readonly canvas: unknown;
  readonly width: number;
  readonly height: number;
}

export class PdfFadeController {
  private readonly pages: PageNode[] = [];

  constructor(private readonly adapter: FadeAdapter) {}

  // Number of currently-tracked pages. Convenient for tests.
  get length(): number {
    return this.pages.length;
  }

  // Atomically swap to a new set of per-page canvases.
  //
  // For each existing page index that has a new canvas: cross-fade
  // (old → new). For new indices beyond `pages.length`: create a
  // wrapper, append the canvas, fade-in the wrapper. For indices
  // disappearing from the new list: fade out and remove.
  //
  // If any page is already mid-fade, snapshot first: remove its
  // leaving canvas, mark its entering canvas as settled, then
  // proceed.
  commit(next: readonly CanvasDescriptor[]): void {
    this.snapshotInFlight();

    const overlap = Math.min(this.pages.length, next.length);

    for (let i = 0; i < overlap; i++) {
      const page = this.pages[i]!;
      const desc = next[i]!;
      this.adapter.setWrapperGeometry(page.wrapper, desc.width, desc.height);
      this.adapter.appendCanvasToWrapper(page.wrapper, desc.canvas);
      this.adapter.startCrossFade({
        wrapper: page.wrapper,
        leaving: page.current,
        entering: desc.canvas,
      });
      page.entering = desc.canvas;
    }

    // Trailing additions.
    for (let i = overlap; i < next.length; i++) {
      const desc = next[i]!;
      const wrapper = this.adapter.createWrapper(i);
      this.adapter.setWrapperGeometry(wrapper, desc.width, desc.height);
      this.adapter.appendCanvasToWrapper(wrapper, desc.canvas);
      this.adapter.fadeInWrapper(wrapper);
      this.pages.push({ wrapper, current: desc.canvas, entering: null });
    }

    // Trailing removals.
    for (let i = this.pages.length - 1; i >= next.length && i >= overlap; i--) {
      const page = this.pages[i]!;
      this.adapter.fadeOutAndRemoveWrapper(page.wrapper);
      this.pages.pop();
    }
  }

  // Called by the host when a cross-fade's transitionend fires.
  // Removes the leaving canvas and marks the entering one settled.
  // Idempotent: a transitionend for a page no longer mid-fade is
  // ignored.
  onFadeEnd(pageIndex: number): void {
    const page = this.pages[pageIndex];
    if (!page || page.entering === null) return;
    if (page.current !== null && page.current !== page.entering) {
      this.adapter.removeCanvasFromWrapper(page.wrapper, page.current);
    }
    page.current = page.entering;
    page.entering = null;
  }

  // Tear down: remove all wrappers. Used on component destroy.
  destroy(): void {
    while (this.pages.length > 0) {
      const page = this.pages.pop()!;
      this.adapter.removeWrapper(page.wrapper);
    }
  }

  // Snapshot any mid-fade pages: drop the leaving canvas, settle on
  // the entering one. Idempotent.
  private snapshotInFlight(): void {
    for (const page of this.pages) {
      if (page.entering === null) continue;
      this.adapter.commitFadeImmediately({
        wrapper: page.wrapper,
        leaving: page.current,
        entering: page.entering,
      });
      page.current = page.entering;
      page.entering = null;
    }
  }
}
