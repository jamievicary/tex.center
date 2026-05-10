<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";

  let { value = $bindable<string>("") }: { value: string } = $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  onMount(() => {
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            value = u.state.doc.toString();
          }
        }),
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
