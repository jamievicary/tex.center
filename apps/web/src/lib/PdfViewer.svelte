<script lang="ts">
  import { onDestroy } from "svelte";

  import { PageTracker } from "./pageTracker";
  import {
    PdfFadeController,
    type FadeAdapter,
  } from "./pdfFadeController";
  import { pdfRenderScale } from "./pdfRenderScale";

  let {
    src,
    onPageChange,
  }: {
    src: Uint8Array | string | null;
    onPageChange?: (page: number) => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let renderToken = 0;

  // Cross-fade duration (M17.b). Synced with the CSS transition
  // duration below; a `transitionend` listener provides the canonical
  // fade-complete signal so this number isn't load-bearing.
  const FADE_MS = 180;

  const tracker = new PageTracker();
  let observer: IntersectionObserver | null = null;
  let controller: PdfFadeController | null = null;

  $effect(() => {
    if (!host || !src) return;
    const token = ++renderToken;
    const target = host;
    void render(src, target, () => token === renderToken);
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

  function makeAdapter(target: HTMLDivElement): FadeAdapter {
    const io = ensureObserver();
    return {
      createWrapper(pageIndex) {
        const w = document.createElement("div");
        w.className = "pdf-page";
        w.dataset.page = String(pageIndex + 1);
        target.appendChild(w);
        io?.observe(w);
        return w;
      },
      removeWrapper(wrapper) {
        const w = wrapper as HTMLDivElement;
        io?.unobserve(w);
        w.remove();
      },
      appendCanvasToWrapper(wrapper, canvas) {
        const w = wrapper as HTMLDivElement;
        const c = canvas as HTMLCanvasElement;
        w.appendChild(c);
      },
      removeCanvasFromWrapper(_wrapper, canvas) {
        (canvas as HTMLCanvasElement).remove();
      },
      setWrapperGeometry(wrapper, width, height) {
        // Set intrinsic width (in canvas px) but cap with max-width
        // 100% in CSS; aspect-ratio keeps height proportional under
        // that responsive scaling. Pages of different sizes still
        // each get their own correct shape.
        const w = wrapper as HTMLDivElement;
        w.style.width = `${width}px`;
        w.style.aspectRatio = `${width} / ${height}`;
      },
      startCrossFade({ wrapper, leaving, entering }) {
        const w = wrapper as HTMLDivElement;
        const enter = entering as HTMLCanvasElement;
        const leave = leaving as HTMLCanvasElement | null;
        enter.classList.add("pdf-canvas--enter");
        enter.style.opacity = "0";
        if (leave) leave.classList.add("pdf-canvas--leave");
        // Force reflow so the transition kicks in from opacity 0.
        void enter.offsetWidth;
        enter.style.opacity = "1";
        if (leave) leave.style.opacity = "0";
        const onEnd = (ev: TransitionEvent) => {
          if (ev.propertyName !== "opacity") return;
          enter.removeEventListener("transitionend", onEnd);
          const idx = (Number(w.dataset.page) || 0) - 1;
          if (idx >= 0) controller?.onFadeEnd(idx);
          enter.classList.remove("pdf-canvas--enter");
        };
        enter.addEventListener("transitionend", onEnd);
      },
      commitFadeImmediately({ wrapper, leaving, entering }) {
        const w = wrapper as HTMLDivElement;
        const enter = entering as HTMLCanvasElement | null;
        const leave = leaving as HTMLCanvasElement | null;
        if (leave && leave !== enter) {
          leave.remove();
        }
        if (enter) {
          enter.classList.remove("pdf-canvas--enter");
          enter.style.opacity = "1";
        }
        void w.offsetWidth;
      },
      fadeInWrapper(wrapper) {
        const w = wrapper as HTMLDivElement;
        w.classList.add("pdf-page--enter");
        w.style.opacity = "0";
        void w.offsetWidth;
        w.style.opacity = "1";
        const onEnd = (ev: TransitionEvent) => {
          if (ev.propertyName !== "opacity") return;
          w.removeEventListener("transitionend", onEnd);
          w.classList.remove("pdf-page--enter");
        };
        w.addEventListener("transitionend", onEnd);
      },
      fadeOutAndRemoveWrapper(wrapper) {
        const w = wrapper as HTMLDivElement;
        io?.unobserve(w);
        w.classList.add("pdf-page--leave");
        w.style.opacity = "0";
        const onEnd = (ev: TransitionEvent) => {
          if (ev.propertyName !== "opacity") return;
          w.removeEventListener("transitionend", onEnd);
          w.remove();
        };
        w.addEventListener("transitionend", onEnd);
      },
    };
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

    controller ??= new PdfFadeController(makeAdapter(target));
    controller.commit(descriptors);
  }

  onDestroy(() => {
    renderToken++;
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
    transition: opacity 180ms ease, width 180ms ease, aspect-ratio 180ms ease;
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
    transition: opacity 180ms ease;
  }
</style>
