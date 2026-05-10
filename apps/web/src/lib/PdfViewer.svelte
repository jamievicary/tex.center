<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  let { src }: { src: string } = $props();

  let host: HTMLDivElement | undefined = $state();
  let cancelled = false;

  onMount(async () => {
    if (!host) return;
    // pdfjs-dist ships an ESM build with a worker module reference.
    // Vite resolves the worker via `?worker&url`. The dynamic import
    // keeps PDF.js out of the SSR/prerender path (which it can't run
    // under) — the editor route is `ssr = false` from the layout.
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const loadingTask = pdfjs.getDocument(src);
    const pdf = await loadingTask.promise;
    if (cancelled) return;
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      host.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;
    }
  });

  onDestroy(() => {
    cancelled = true;
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
