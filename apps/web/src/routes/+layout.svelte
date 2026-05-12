<script lang="ts">
  import Toasts from "$lib/Toasts.svelte";
  let { children } = $props();
</script>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
  }
</style>

{@render children()}
<Toasts />
