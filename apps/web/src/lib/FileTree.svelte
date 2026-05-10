<script lang="ts">
  let {
    files,
    selected = $bindable<string>(""),
  }: { files: string[]; selected: string } = $props();
</script>

<ul>
  {#each files as f (f)}
    <li>
      <button
        type="button"
        class:active={f === selected}
        onclick={() => (selected = f)}
      >
        {f}
      </button>
    </li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
  }
  li {
    margin: 0;
  }
  button {
    display: block;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    background: #f3f4f6;
  }
  button.active {
    background: #e5e7eb;
  }
</style>
