<script lang="ts">
  // Toast stack overlay. Mounts once at the layout level and
  // renders the global `toasts` store. Color is derived from
  // category; debug-* categories are styled the same as their
  // user-facing siblings but with a smaller, monospace text.
  import { onDestroy } from "svelte";
  import { toasts, type Toast } from "./toastStore";

  // Items rendered newest-on-top. The store keeps insertion
  // order; we reverse for display so the most recent push appears
  // at the top of the flex-column stack and older toasts drift
  // downward as new ones arrive.
  let items = $state<ReadonlyArray<Toast>>([]);
  const unsub = toasts.subscribe((t) => {
    items = t.slice().reverse();
  });
  onDestroy(unsub);
</script>

<div class="toast-stack" aria-live="polite" aria-atomic="false">
  {#each items as t (t.id)}
    <div
      class="toast {t.category}"
      class:debug={t.category.startsWith("debug-")}
      data-toast-id={t.id}
      data-toast-category={t.category}
      role={t.category === "error" ? "alert" : "status"}
    >
      <span class="text">{t.text}</span>
      {#if t.count > 1}
        <span class="count" data-toast-count={t.count}>×{t.count}</span>
      {/if}
      {#if t.persistent || t.category === "info" || t.category === "success"}
        <button
          type="button"
          class="dismiss"
          aria-label="dismiss"
          onclick={() => toasts.dismiss(t.id)}
        >
          ×
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    bottom: 0.75rem;
    right: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-end;
    z-index: 9999;
    pointer-events: none;
    max-width: 24rem;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.7rem;
    border-radius: 4px;
    color: white;
    font-size: 0.85rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    line-height: 1.3;
  }
  .toast.debug {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    opacity: 0.92;
  }
  .toast.info {
    background: #2563eb;
  }
  .toast.success {
    background: #15803d;
  }
  .toast.error {
    background: #b91c1c;
  }
  .toast.debug-blue {
    background: #2563eb;
  }
  .toast.debug-green {
    background: #15803d;
  }
  .toast.debug-orange {
    background: #c2410c;
  }
  .toast.debug-grey {
    background: #4b5563;
  }
  .toast.debug-red {
    background: #b91c1c;
  }
  .count {
    background: rgba(255, 255, 255, 0.25);
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .dismiss {
    background: transparent;
    color: inherit;
    border: 0;
    padding: 0 0.25rem;
    font-size: 1rem;
    cursor: pointer;
    line-height: 1;
  }
</style>
