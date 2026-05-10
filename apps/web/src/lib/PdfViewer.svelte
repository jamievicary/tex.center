<script lang="ts">
  import { onDestroy } from "svelte";

  let { src }: { src: Uint8Array | string | null } = $props();

  let host: HTMLDivElement | undefined = $state();
  let renderToken = 0;

  $effect(() => {
    if (!host || !src) return;
    const token = ++renderToken;
    const target = host;
    void render(src, target, () => token === renderToken);
  });

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
    target.replaceChildren();
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if (!isCurrent()) return;
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      target.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (!isCurrent()) return;
    }
  }

  onDestroy(() => {
    renderToken++;
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
