<script lang="ts">
  import Editor from "$lib/Editor.svelte";
  import FileTree from "$lib/FileTree.svelte";
  import PdfViewer from "$lib/PdfViewer.svelte";

  let files = $state<string[]>(["main.tex"]);
  let selected = $state<string>("main.tex");
  let doc = $state<string>(
    "\\documentclass{article}\n\\begin{document}\nHello, tex.center.\n\\end{document}\n",
  );
</script>

<div class="shell">
  <aside class="tree">
    <FileTree {files} bind:selected />
  </aside>
  <section class="editor">
    <Editor bind:value={doc} />
  </section>
  <section class="preview">
    <PdfViewer src="/fixture.pdf" />
  </section>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 220px 1fr 1fr;
    height: 100vh;
    width: 100vw;
  }
  .tree {
    border-right: 1px solid #e5e7eb;
    overflow: auto;
  }
  .editor {
    border-right: 1px solid #e5e7eb;
    overflow: hidden;
    min-width: 0;
  }
  .preview {
    overflow: auto;
    background: #f3f4f6;
    min-width: 0;
  }
</style>
