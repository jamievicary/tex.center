<script lang="ts">
  import { untrack } from "svelte";
  import { MAIN_DOC_NAME, validateProjectFileName } from "@tex-center/protocol";
  import { buildFileTree, type FileTreeNode } from "./fileTree.js";
  import { classifyDroppedNames } from "./fileDropUpload.js";
  import {
    createFileTreeInstance,
    type FileItemData,
  } from "./fileTreeHeadless.js";

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

  // Set of folder paths the user has explicitly collapsed.
  // Default (empty) → every folder is expanded, matching the
  // pre-cutover behaviour where a missing `collapsed` map entry
  // was treated as "not collapsed".
  let collapsed = $state(new Set<string>());

  // Bumped inside the headless-tree adapter's `onStateChange` to
  // force the flat-row `$derived` to re-evaluate when the tree
  // mutates state in place (expand/collapse).
  let tick = $state(0);

  let forest = $derived(buildFileTree(files));

  function collectFolderPaths(nodes: readonly FileTreeNode[], out: string[]): string[] {
    for (const n of nodes) {
      if (n.kind === "folder") {
        out.push(n.path);
        collectFolderPaths(n.children, out);
      }
    }
    return out;
  }

  // Rebuild the headless-tree instance whenever `forest` changes.
  // Don't track `collapsed` here — user expand/collapse calls
  // mutate the instance in place; only a files-list change (which
  // forces a new forest) should construct a fresh instance.
  let tree = $derived.by(() => {
    const currentForest = forest;
    return untrack(() => {
      const folderPaths = collectFolderPaths(currentForest, []);
      const initialExpanded = folderPaths.filter((p) => !collapsed.has(p));
      return createFileTreeInstance(currentForest, {
        initialExpanded,
        onStateChange: (s) => {
          const expandedSet = new Set(s.expandedItems ?? []);
          const next = new Set<string>();
          for (const p of folderPaths) if (!expandedSet.has(p)) next.add(p);
          collapsed = next;
          tick++;
        },
      });
    });
  });

  interface Row {
    id: string;
    data: FileItemData;
    level: number;
    isFolder: boolean;
    isExpanded: boolean;
  }

  let rows = $derived.by<Row[]>(() => {
    tick;
    return tree.getItems().map((item) => ({
      id: item.getId(),
      data: item.getItemData(),
      level: item.getItemMeta().level,
      isFolder: item.isFolder(),
      isExpanded: item.isExpanded(),
    }));
  });

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

  // M11.5a: drop-text-upload affordance. The whole tree column is
  // a drop zone; while the user is dragging a `Files` payload over
  // it, the `dragover` flag flips on for a visible outline. Drop
  // funnels names through `classifyDroppedNames` and uploads each
  // accepted entry via `onUploadFile` (the same wire path as the
  // picker-flow upload). Rejects surface as `window.alert` for
  // parity with the picker UX.
  let isDragOver = $state(false);

  function dragHasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  function onDragOver(e: DragEvent): void {
    if (!onUploadFile) return;
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    isDragOver = true;
  }

  function onDragLeave(e: DragEvent): void {
    // Only clear when the pointer truly leaves the wrapper. A
    // `dragleave` fires on every child traversal, but
    // `relatedTarget` is null/outside-the-zone only on the boundary
    // exit. Without this guard the affordance flickers as the
    // pointer crosses children.
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as Node | null;
    if (related && current && current.contains(related)) return;
    isDragOver = false;
  }

  async function onDrop(e: DragEvent): Promise<void> {
    if (!onUploadFile) return;
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    isDragOver = false;
    const list = e.dataTransfer?.files;
    if (!list || list.length === 0) return;
    const items: File[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i);
      if (f) items.push(f);
    }
    const { accepted, rejected } = classifyDroppedNames(
      items.map((f) => f.name),
      files,
    );
    for (const r of rejected) {
      window.alert(`Cannot upload "${r.name}": ${r.reason}.`);
    }
    const acceptSet = new Set(accepted);
    for (const file of items) {
      if (!acceptSet.has(file.name.trim())) continue;
      const content = await file.text();
      onUploadFile(file.name.trim(), content);
    }
  }

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

  function toggleFolder(id: string): void {
    const inst = tree.getItemInstance(id);
    if (inst.isExpanded()) inst.collapse();
    else inst.expand();
  }

  function selectFile(path: string): void {
    selected = path;
  }
</script>

<div
  class="ft-host"
  class:dragover={isDragOver}
  data-testid="filetree-host"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
<ul class="root" role="tree">
  {#each rows as row (row.id)}
    {@const indent = `${row.level * 0.75}rem`}
    {#if row.isFolder}
      <li class="folder" role="treeitem" aria-expanded={row.isExpanded}>
        <button
          type="button"
          class="row folder-row"
          style:padding-left={indent}
          aria-expanded={row.isExpanded}
          onclick={() => toggleFolder(row.id)}
        >
          <span class="chev" aria-hidden="true">{row.isExpanded ? "▾" : "▸"}</span>
          <span class="label">{row.data.name}/</span>
        </button>
      </li>
    {:else}
      <li class="file" role="treeitem">
        <button
          type="button"
          class="row file-row"
          class:active={row.data.path === selected}
          style:padding-left={indent}
          onclick={() => selectFile(row.data.path)}
        >
          <span class="label">{row.data.name}</span>
        </button>
        {#if onRenameFile && row.data.path !== MAIN_DOC_NAME}
          <button
            type="button"
            class="ren"
            aria-label={`rename ${row.data.path}`}
            onclick={() => promptRename(row.data.path)}
          >✎</button>
        {/if}
        {#if onDeleteFile && row.data.path !== MAIN_DOC_NAME}
          <button
            type="button"
            class="del"
            aria-label={`delete ${row.data.path}`}
            onclick={() => onDeleteFile(row.data.path)}
          >×</button>
        {/if}
      </li>
    {/if}
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
</div>

<style>
  .ft-host {
    min-height: 100%;
    box-sizing: border-box;
    /* Transparent 2px outline reserved so the dragover state can
       light up without shifting the children. */
    outline: 2px dashed transparent;
    outline-offset: -2px;
  }
  .ft-host.dragover {
    outline-color: #2563eb;
    background: rgba(37, 99, 235, 0.04);
  }
  ul.root {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
  }
  li {
    margin: 0;
    display: flex;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .row {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .row:hover {
    background: #f3f4f6;
  }
  .file-row.active {
    background: #e5e7eb;
  }
  .chev {
    display: inline-block;
    width: 0.9em;
    color: #6b7280;
    font-size: 0.85em;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del,
  .ren {
    flex: 0 0 auto;
    padding: 0 0.5rem;
    border: 0;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    font: inherit;
  }
  .del:hover {
    color: #b91c1c;
  }
  .ren:hover {
    color: #1d4ed8;
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
