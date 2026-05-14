<script lang="ts">
  import type { FileTreeNode } from "./fileTree.js";
  import { MAIN_DOC_NAME } from "@tex-center/protocol";
  import Self from "./FileTreeNode.svelte";

  let {
    node,
    depth,
    selected,
    collapsed,
    onToggleFolder,
    onSelect,
    onRename,
    onDelete,
  }: {
    node: FileTreeNode;
    depth: number;
    selected: string;
    collapsed: ReadonlyMap<string, boolean>;
    onToggleFolder: (path: string) => void;
    onSelect: (path: string) => void;
    onRename?: ((path: string) => void) | undefined;
    onDelete?: ((path: string) => void) | undefined;
  } = $props();

  const indent = $derived(`${depth * 0.75}rem`);
</script>

{#if node.kind === "folder"}
  {@const isCollapsed = collapsed.get(node.path) === true}
  <li class="folder">
    <button
      type="button"
      class="row folder-row"
      style:padding-left={indent}
      aria-expanded={!isCollapsed}
      onclick={() => onToggleFolder(node.path)}
    >
      <span class="chev" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
      <span class="label">{node.name}/</span>
    </button>
    {#if !isCollapsed}
      <ul>
        {#each node.children as child (child.path)}
          <Self
            node={child}
            depth={depth + 1}
            {selected}
            {collapsed}
            {onToggleFolder}
            {onSelect}
            {onRename}
            {onDelete}
          />
        {/each}
      </ul>
    {/if}
  </li>
{:else}
  <li class="file">
    <button
      type="button"
      class="row file-row"
      class:active={node.path === selected}
      style:padding-left={indent}
      onclick={() => onSelect(node.path)}
    >
      <span class="label">{node.name}</span>
    </button>
    {#if onRename && node.path !== MAIN_DOC_NAME}
      <button
        type="button"
        class="ren"
        aria-label={`rename ${node.path}`}
        onclick={() => onRename(node.path)}
      >✎</button>
    {/if}
    {#if onDelete && node.path !== MAIN_DOC_NAME}
      <button
        type="button"
        class="del"
        aria-label={`delete ${node.path}`}
        onclick={() => onDelete(node.path)}
      >×</button>
    {/if}
  </li>
{/if}

<style>
  li {
    margin: 0;
    display: flex;
    align-items: stretch;
    flex-wrap: wrap;
  }
  li.folder {
    flex-direction: column;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
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
</style>
