<script lang="ts">
  import { MAIN_DOC_NAME, validateProjectFileName } from "@tex-center/protocol";
  import { buildFileTree } from "./fileTree.js";
  import FileTreeNode from "./FileTreeNode.svelte";

  let {
    files,
    selected = $bindable<string>(""),
    onCreateFile,
    onDeleteFile,
    onRenameFile,
    onUploadFile,
    serverError = null,
  }: {
    files: string[];
    selected: string;
    onCreateFile?: (name: string) => void;
    onDeleteFile?: (name: string) => void;
    onRenameFile?: (oldName: string, newName: string) => void;
    onUploadFile?: (name: string, content: string) => void;
    /**
     * Last server-side rejection of a file-tree op (race-rejected
     * create / delete / rename / upload), surfaced inline. Clears
     * when the client receives the next `file-list` (= some op
     * succeeded).
     */
    serverError?: string | null;
  } = $props();

  let newName = $state("");
  let collapsed = $state(new Map<string, boolean>());

  let forest = $derived(buildFileTree(files));

  function rejectionReason(candidate: string, ignore?: string): string | null {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    const base = validateProjectFileName(trimmed);
    if (base) return base;
    if (trimmed === MAIN_DOC_NAME) return "name reserved";
    if (files.includes(trimmed) && trimmed !== ignore) return "already exists";
    return null;
  }

  let createError = $derived(rejectionReason(newName));
  let createDisabled = $derived(!newName.trim() || createError !== null);

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || !onCreateFile || createError) return;
    onCreateFile(trimmed);
    newName = "";
  }

  let uploadInput: HTMLInputElement | undefined = $state();

  async function handleUploadChange(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const list = input.files;
    if (!list || !onUploadFile) {
      input.value = "";
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const file = list.item(i);
      if (!file) continue;
      const reason = rejectionReason(file.name);
      if (reason) {
        window.alert(`Cannot upload "${file.name}": ${reason}.`);
        continue;
      }
      const content = await file.text();
      onUploadFile(file.name, content);
    }
    input.value = "";
  }

  function promptRename(path: string): void {
    if (!onRenameFile) return;
    const next = window.prompt(`Rename ${path} to:`, path);
    const trimmed = next?.trim();
    if (!trimmed || trimmed === path) return;
    const reason = rejectionReason(trimmed, path);
    if (reason) {
      window.alert(`Cannot rename to "${trimmed}": ${reason}.`);
      return;
    }
    onRenameFile(path, trimmed);
  }

  function toggleFolder(path: string): void {
    const next = new Map(collapsed);
    next.set(path, !(next.get(path) === true));
    collapsed = next;
  }

  function selectFile(path: string): void {
    selected = path;
  }
</script>

<ul class="root">
  {#each forest as node (node.path)}
    <FileTreeNode
      {node}
      depth={0}
      {selected}
      collapsed={collapsed}
      onToggleFolder={toggleFolder}
      onSelect={selectFile}
      onRename={onRenameFile ? promptRename : undefined}
      onDelete={onDeleteFile}
    />
  {/each}
</ul>

{#if onCreateFile || onUploadFile}
  <form class="new" onsubmit={handleSubmit}>
    {#if onCreateFile}
      <input
        type="text"
        bind:value={newName}
        placeholder="new-file.tex"
        aria-label="new file name"
        aria-invalid={createError !== null}
      />
      <button type="submit" disabled={createDisabled}>+</button>
    {/if}
    {#if onUploadFile}
      <button
        type="button"
        class="up"
        aria-label="upload files"
        onclick={() => uploadInput?.click()}
      >↑</button>
      <input
        bind:this={uploadInput}
        type="file"
        multiple
        hidden
        onchange={handleUploadChange}
      />
    {/if}
  </form>
  {#if createError}
    <p class="err" role="alert">{createError}</p>
  {:else if serverError}
    <p class="err" role="alert">server: {serverError}</p>
  {/if}
{/if}

<style>
  ul.root {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
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
  .new button.up {
    padding: 0.25rem 0.5rem;
  }
  .err {
    margin: 0;
    padding: 0.15rem 0.5rem 0.4rem;
    font-size: 0.75rem;
    color: #b91c1c;
  }
</style>
