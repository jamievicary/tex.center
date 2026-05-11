<script lang="ts">
  import { MAIN_DOC_NAME } from "@tex-center/protocol";

  let {
    files,
    selected = $bindable<string>(""),
    onCreateFile,
    onDeleteFile,
    onRenameFile,
  }: {
    files: string[];
    selected: string;
    onCreateFile?: (name: string) => void;
    onDeleteFile?: (name: string) => void;
    onRenameFile?: (oldName: string, newName: string) => void;
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
      {#if onRenameFile && f !== MAIN_DOC_NAME}
        <button
          type="button"
          class="ren"
          aria-label={`rename ${f}`}
          onclick={() => {
            const next = window.prompt(`Rename ${f} to:`, f);
            const trimmed = next?.trim();
            if (trimmed && trimmed !== f) onRenameFile(f, trimmed);
          }}
        >✎</button>
      {/if}
      {#if onDeleteFile && f !== MAIN_DOC_NAME}
        <button
          type="button"
          class="del"
          aria-label={`delete ${f}`}
          onclick={() => onDeleteFile(f)}
        >×</button>
      {/if}
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
    display: flex;
    align-items: stretch;
  }
  ul button {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  ul button.del,
  ul button.ren {
    flex: 0 0 auto;
    padding: 0 0.5rem;
    color: #9ca3af;
  }
  ul button.del:hover {
    color: #b91c1c;
    background: transparent;
  }
  ul button.ren:hover {
    color: #1d4ed8;
    background: transparent;
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
