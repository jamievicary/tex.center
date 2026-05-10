<script lang="ts">
  import { onDestroy } from "svelte";

  import { PageTracker } from "./pageTracker";

  let {
    src,
    onPageChange,
  }: {
    src: Uint8Array | string | null;
    onPageChange?: (page: number) => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let renderToken = 0;

  // One IO + tracker per viewer instance, reused across renders.
  // The IO root is the scrolling preview pane (the parent of the
  // host); we use the document viewport as fallback for SSR-safety
  // by passing `root: null` and relying on the preview pane being
  // viewport-sized in practice. (M3 page tracking; refine if the
  // preview pane stops being the scroll viewport.)
  const tracker = new PageTracker();
  let observer: IntersectionObserver | null = null;

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
          const next = tracker.update(page, e.intersectionRatio);
          if (next !== null) onPageChange?.(next);
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
    // Tear down old canvases + observation before rendering anew.
    observer?.disconnect();
    tracker.reset();
    target.replaceChildren();
    const io = ensureObserver();
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if (!isCurrent()) return;
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.dataset.page = String(pageNum);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      target.appendChild(canvas);
      io?.observe(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (!isCurrent()) return;
    }
  }

  onDestroy(() => {
    renderToken++;
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
  :global(.host canvas) {
    max-width: 100%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
</style>
