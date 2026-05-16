<script lang="ts">
  import { onDestroy } from "svelte";

  import { PageTracker } from "./pageTracker";
  import { PdfFadeController } from "./pdfFadeController";
  import { createFadeAdapter } from "./pdfFadeAdapter";
  import { pdfRenderScale } from "./pdfRenderScale";

  let {
    src,
    lastPage,
    onPageChange,
  }: {
    src: Uint8Array | string | null;
    /**
     * Tri-state echo of the most recent `pdf-segment.lastPage` wire
     * field (iter 372 / M21 iter B). `false` ⇒ the document has at
     * least one more page past the last shipped page; the viewer
     * reserves a same-size placeholder `.pdf-page` slot so the
     * IntersectionObserver can promote `maxViewingPage` once it
     * enters view, driving a sidecar `recompile,N+1`. `true` /
     * `undefined` ⇒ no placeholder (`true` ≡ daemon hit
     * `\enddocument`; `undefined` ≡ compiler does not expose the
     * signal, so the legacy "every page shipped" model applies and
     * there's no missing page to fetch).
     */
    lastPage?: boolean | undefined;
    onPageChange?: (page: number) => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let renderToken = 0;

  // Cross-fade duration is owned by the editor settings store and
  // applied to the CSS transitions via the `--pdf-fade-ms` custom
  // property set on `.shell` (see editor/[projectId]/+page.svelte).
  // A `transitionend` listener is the canonical fade-complete
  // signal — duration is purely user-visible, not load-bearing in
  // any JS state machine.

  const tracker = new PageTracker();
  let observer: IntersectionObserver | null = null;
  let controller: PdfFadeController | null = null;

  // Geometry of the most recently rendered page; used to size the
  // demand-fetch placeholder slot so it reserves a realistic
  // viewport entry trigger. Falls back to A4 if no page has rendered
  // yet (bootstrap on a fresh project before the first segment).
  let lastPageGeometry: { width: number; height: number } = {
    width: 595,
    height: 842,
  };
  let placeholderEl: HTMLDivElement | null = null;

  function syncPlaceholder(): void {
    const target = host;
    if (!target) return;
    const want =
      lastPage === false && controller !== null && controller.length > 0;
    if (!want) {
      removePlaceholder();
      return;
    }
    const nextPage = controller!.length + 1; // 1-indexed page number
    if (!placeholderEl) {
      const el = document.createElement("div");
      el.className = "pdf-page pdf-page-placeholder";
      el.dataset.page = String(nextPage);
      el.dataset.placeholder = "1";
      // Sized like a real page so its viewport ratio is comparable.
      // PageTracker treats `data-page` numerically; the observer
      // path is identical to a real wrapper's, so a scroll-into-view
      // bumps `maxViewingPage` and the sidecar receives the
      // corresponding `view` frame.
      target.appendChild(el);
      placeholderEl = el;
      ensureObserver()?.observe(el);
    } else if (placeholderEl.dataset.page !== String(nextPage)) {
      placeholderEl.dataset.page = String(nextPage);
    }
    placeholderEl.style.width = `${lastPageGeometry.width}px`;
    placeholderEl.style.aspectRatio = `${lastPageGeometry.width} / ${lastPageGeometry.height}`;
  }

  function removePlaceholder(): void {
    if (!placeholderEl) return;
    observer?.unobserve(placeholderEl);
    placeholderEl.remove();
    placeholderEl = null;
  }

  $effect(() => {
    if (!host || !src) return;
    const token = ++renderToken;
    const target = host;
    // Remove the placeholder *before* re-rendering so the controller's
    // trailing-addition path (which appends new wrappers as last
    // children of the host) keeps page wrappers in DOM order. The
    // placeholder, if still wanted, is re-mounted after the commit
    // returns — see syncPlaceholder().
    removePlaceholder();
    // Iter 355 (`.autodev/discussion/354_answer.md`): the rendering
    // path used to throw silently — `void render(...)` discards a
    // rejected promise, no UI signal, no log. The
    // `verifyLiveFullPipelineReused` gold spec timed out waiting for
    // `.preview canvas` to attach with no captured cause. Surface the
    // error: console.error so Playwright's `page.on('console')`
    // capture in `authedPage.ts` picks it up, plus a
    // `data-pdf-error` attribute on the host so future specs can
    // assert "no render error" rather than blindly waiting for a
    // canvas that will never come. Clear on every fresh render so
    // a recovered-from-transient failure doesn't leave stale state.
    delete target.dataset.pdfError;
    render(src, target, () => token === renderToken)
      .then(() => {
        if (token !== renderToken) return;
        syncPlaceholder();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("[PdfViewer] render failed:", message);
        target.dataset.pdfError = message;
      });
  });

  // Independently react to `lastPage` flipping (a same-bytes segment
  // can carry a different tri-state value, and the FE must add or
  // remove the placeholder synchronously without waiting for the
  // next PDF re-render).
  $effect(() => {
    // Read the reactive prop so Svelte tracks it.
    void lastPage;
    syncPlaceholder();
  });

  function ensureObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === "undefined") return null;
    if (observer) return observer;
    const thresholds = Array.from({ length: 11 }, (_, i) => i / 10);
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pageAttr = (e.target as HTMLElement).dataset.page;
          if (!pageAttr) continue;
          const page = Number(pageAttr);
          if (!Number.isFinite(page)) continue;
          const { maxVisible } = tracker.update(page, e.intersectionRatio);
          if (maxVisible !== null) onPageChange?.(maxVisible);
        }
      },
      { threshold: thresholds },
    );
    return observer;
  }

  async function render(
    src: Uint8Array | string,
    target: HTMLDivElement,
    isCurrent: () => boolean,
  ): Promise<void> {
    // pdfjs-dist ships an ESM build with a worker module reference.
    // The dynamic import keeps PDF.js out of the SSR/prerender path
    // (which it can't run under) — the editor route is `ssr = false`.
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    if (!isCurrent()) return;

    // pdfjs mutates the source buffer; hand it a copy so external
    // refs (e.g. the WsClient's snapshot) remain safe to inspect.
    const docSrc =
      typeof src === "string" ? src : { data: new Uint8Array(src) };
    const loadingTask = pdfjs.getDocument(docSrc);
    const pdf = await loadingTask.promise;
    if (!isCurrent()) {
      void pdf.destroy();
      return;
    }

    // Off-DOM render every page; the canvas is fully painted before
    // it ever attaches to the document. No flash, no per-page pop-in.
    //
    // Pixel scale is multiplied by devicePixelRatio (cached once per
    // commit so all pages share one DPR even if the screen changes
    // mid-render). The descriptor handed to the fade controller
    // carries CSS-px dimensions so layout is independent of DPR.
    const { cssScale, pixelScale } = pdfRenderScale(
      1.5,
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    );
    const descriptors: { canvas: HTMLCanvasElement; width: number; height: number }[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if (!isCurrent()) return;
      const cssViewport = page.getViewport({ scale: cssScale });
      const pixelViewport = page.getViewport({ scale: pixelScale });
      const canvas = document.createElement("canvas");
      canvas.width = pixelViewport.width;
      canvas.height = pixelViewport.height;
      canvas.className = "pdf-canvas";
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport: pixelViewport }).promise;
      if (!isCurrent()) return;
      descriptors.push({
        canvas,
        width: cssViewport.width,
        height: cssViewport.height,
      });
    }

    controller ??= new PdfFadeController(
      createFadeAdapter({
        target,
        observer: ensureObserver(),
        onFadeEnd: (idx) => controller?.onFadeEnd(idx),
      }),
    );
    controller.commit(descriptors);
    // Remember the last real page's CSS-px geometry so the
    // demand-fetch placeholder (mounted after this render in
    // syncPlaceholder()) reserves a same-shape slot for page N+1.
    const last = descriptors[descriptors.length - 1];
    if (last) lastPageGeometry = { width: last.width, height: last.height };
  }

  onDestroy(() => {
    renderToken++;
    removePlaceholder();
    controller?.destroy();
    controller = null;
    observer?.disconnect();
    observer = null;
  });
</script>

<div class="host" bind:this={host}></div>

<style>
  .host {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
  }
  :global(.host .pdf-page) {
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    max-width: 100%;
    transition:
      opacity var(--pdf-fade-ms, 180ms) ease,
      width var(--pdf-fade-ms, 180ms) ease,
      aspect-ratio var(--pdf-fade-ms, 180ms) ease;
  }
  /*
   * Both canvases are absolutely positioned inside the wrapper, so
   * a mid-fade two-canvas state stacks them without re-flowing the
   * page. The wrapper carries the intrinsic width/height set by
   * `setWrapperGeometry`, so layout is stable across fades.
   */
  :global(.host .pdf-page > canvas) {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    transition: opacity var(--pdf-fade-ms, 180ms) ease;
  }
  /* Demand-fetch placeholder (iter 372 / M21 iter B): same outline
     as a real `.pdf-page` so its IntersectionObserver ratio is
     directly comparable, but visually distinct (subtle paper tone +
     dashed outline) so the user knows the slot is empty and will
     fill on scroll. No canvas child — width/aspect-ratio come from
     inline style copied off the most recent real page. */
  :global(.host .pdf-page-placeholder) {
    background: rgba(250, 247, 240, 0.55);
    border: 1px dashed rgba(31, 27, 22, 0.18);
    box-shadow: none;
  }
</style>
