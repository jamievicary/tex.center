<script lang="ts">
  let {
    files,
    selected = $bindable<string>(""),
    onCreateFile,
  }: {
    files: string[];
    selected: string;
    onCreateFile?: (name: string) => void;
  } = $props();

  let newName = $state("");

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || !onCreateFile) return;
    onCreateFile(trimmed);
    newName = "";
  }
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

{#if onCreateFile}
  <form class="new" onsubmit={handleSubmit}>
    <input
      type="text"
      bind:value={newName}
      placeholder="new-file.tex"
      aria-label="new file name"
    />
    <button type="submit" disabled={!newName.trim()}>+</button>
  </form>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
  }
  li {
    margin: 0;
  }
  ul button {
    display: block;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  ul button:hover {
    background: #f3f4f6;
  }
  ul button.active {
    background: #e5e7eb;
  }
  .new {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-top: 1px solid #e5e7eb;
  }
  .new input {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.4rem;
    font: inherit;
    border: 1px solid #d1d5db;
    border-radius: 3px;
  }
  .new button {
    padding: 0.25rem 0.5rem;
    border: 1px solid #d1d5db;
    background: white;
    border-radius: 3px;
    cursor: pointer;
  }
  .new button:disabled {
    cursor: default;
    color: #9ca3af;
  }
</style>
