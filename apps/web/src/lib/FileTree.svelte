<script lang="ts">
  import { untrack } from "svelte";
  import { MAIN_DOC_NAME, validateProjectFileName } from "@tex-center/protocol";
  import { buildFileTree, type FileTreeNode } from "./fileTree.js";
  import { classifyDroppedNames } from "./fileDropUpload.js";
  import { decideFileRowAction } from "./fileTreeKeyboard.js";
  import {
    createFileTreeInstance,
    type FileItemData,
  } from "./fileTreeHeadless.js";
  import {
    decideMenuKeyAction,
    initialMenuFocus,
    menuItemsForFile,
    menuItemsForRoot,
    moveMenuFocus,
    type MenuAction,
    type MenuItem,
  } from "./fileTreeContextMenu.js";

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

  function promptCreate(): void {
    if (!onCreateFile) return;
    const next = window.prompt("New file name:", "");
    const trimmed = next?.trim();
    if (!trimmed) return;
    const reason = rejectionReason(trimmed);
    if (reason) {
      window.alert(`Cannot create "${trimmed}": ${reason}.`);
      return;
    }
    onCreateFile(trimmed);
  }

  function confirmDelete(path: string): void {
    if (!onDeleteFile) return;
    if (!window.confirm(`Delete ${path}?`)) return;
    onDeleteFile(path);
  }

  // M11.2b: right-click context menu. Open state carries the screen
  // coordinates of the originating event, the list of items, the
  // focused index for arrow-key nav, and (for file menus) the path
  // the menu was opened against. Mutually exclusive — a fresh
  // contextmenu replaces an open menu instead of stacking.
  interface OpenMenu {
    x: number;
    y: number;
    items: MenuItem[];
    focused: number;
    /** Present for file-row menus; absent for root menus. */
    path?: string;
  }
  let menu = $state<OpenMenu | null>(null);

  function openFileMenu(e: MouseEvent, path: string): void {
    e.preventDefault();
    e.stopPropagation();
    const items = menuItemsForFile(path, MAIN_DOC_NAME);
    menu = { x: e.clientX, y: e.clientY, items, focused: initialMenuFocus(items), path };
  }

  function openRootMenu(e: MouseEvent): void {
    if (!onCreateFile) return;
    e.preventDefault();
    const items = menuItemsForRoot();
    menu = { x: e.clientX, y: e.clientY, items, focused: initialMenuFocus(items) };
  }

  function dismissMenu(): void {
    menu = null;
  }

  function invokeMenu(action: MenuAction, path: string | undefined): void {
    dismissMenu();
    if (action === "create") {
      promptCreate();
    } else if (action === "rename" && path !== undefined) {
      promptRename(path);
    } else if (action === "delete" && path !== undefined) {
      confirmDelete(path);
    }
  }

  function onMenuItemClick(item: MenuItem): void {
    if (!item.enabled || menu === null) return;
    invokeMenu(item.action, menu.path);
  }

  function onMenuKeyDown(e: KeyboardEvent): void {
    if (menu === null) return;
    const action = decideMenuKeyAction(e);
    if (action === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === "dismiss") {
      dismissMenu();
      return;
    }
    if (action.kind === "prev") {
      menu = { ...menu, focused: moveMenuFocus(menu.items, menu.focused, -1) };
      return;
    }
    if (action.kind === "next") {
      menu = { ...menu, focused: moveMenuFocus(menu.items, menu.focused, 1) };
      return;
    }
    // activate
    const item = menu.items[menu.focused];
    if (item && item.enabled) {
      invokeMenu(item.action, menu.path);
    }
  }

  // Pointerdown anywhere outside the menu element dismisses it. The
  // menu's own pointerdown handler stops propagation, so this fires
  // only on truly-outside clicks (including on file rows themselves
  // — clicking another row should both dismiss the menu and select
  // that row, which is the same as the user's mental model).
  function onWindowPointerDown(): void {
    if (menu !== null) dismissMenu();
  }

  function onMenuPointerDown(e: PointerEvent): void {
    e.stopPropagation();
  }

  // Auto-focus the menu wrapper on open so keyboard nav works
  // without the user clicking into it.
  function autoFocus(node: HTMLElement): void {
    node.focus();
  }

  // M11.2a: keyboard CRUD on the focused file row. F2 → rename
  // (existing prompt flow); Delete/Backspace → confirm-then-delete.
  // Keyboard delete is one keystroke away from accident, so it gates
  // on `window.confirm`; the explicit `×` button stays one-click
  // because clicking the trash glyph is itself the confirmation.
  function onFileRowKeyDown(e: KeyboardEvent, path: string): void {
    const action = decideFileRowAction(e, path, MAIN_DOC_NAME);
    if (action === null) return;
    if (action === "rename") {
      if (!onRenameFile) return;
      e.preventDefault();
      promptRename(path);
      return;
    }
    if (action === "delete") {
      if (!onDeleteFile) return;
      e.preventDefault();
      if (!window.confirm(`Delete ${path}?`)) return;
      onDeleteFile(path);
    }
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

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  class="ft-host"
  class:dragover={isDragOver}
  data-testid="filetree-host"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  oncontextmenu={openRootMenu}
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
          onkeydown={(e) => onFileRowKeyDown(e, row.data.path)}
          oncontextmenu={(e) => openFileMenu(e, row.data.path)}
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

{#if menu !== null}
  <div
    class="ctx-menu"
    role="menu"
    data-testid="filetree-context-menu"
    style:left="{menu.x}px"
    style:top="{menu.y}px"
    tabindex="-1"
    use:autoFocus
    onpointerdown={onMenuPointerDown}
    onkeydown={onMenuKeyDown}
  >
    {#each menu.items as item, i (item.action)}
      <button
        type="button"
        role="menuitem"
        class="ctx-item"
        class:focused={i === menu.focused}
        disabled={!item.enabled}
        data-action={item.action}
        onclick={() => onMenuItemClick(item)}
        onmouseenter={() => (menu = menu === null ? null : { ...menu, focused: i })}
      >{item.label}</button>
    {/each}
  </div>
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
  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 9rem;
    padding: 0.25rem 0;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .ctx-item {
    display: block;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .ctx-item.focused:not(:disabled) {
    background: #e5e7eb;
  }
  .ctx-item:disabled {
    color: #9ca3af;
    cursor: default;
  }
</style>
