<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { yCollab } from "y-codemirror.next";
  import type * as Y from "yjs";

  let { text, readOnly = false }: { text: Y.Text; readOnly?: boolean } =
    $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  onMount(() => {
    if (!host) return;
    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        basicSetup,
        yCollab(text, null),
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
      ],
    });
    view = new EditorView({ state, parent: host });
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div class="host" bind:this={host}></div>

<style>
  .host {
    height: 100%;
    width: 100%;
    overflow: auto;
  }
  :global(.cm-editor) {
    height: 100%;
  }
</style>
