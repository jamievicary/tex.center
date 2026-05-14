<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import * as Y from "yjs";

  import { env as publicEnv } from "$env/dynamic/public";
  const PUBLIC_TEXCENTER_ITER = publicEnv.PUBLIC_TEXCENTER_ITER ?? "dev";
  import Editor from "$lib/Editor.svelte";
  import FileTree from "$lib/FileTree.svelte";
  import PdfViewer from "$lib/PdfViewer.svelte";
  import linearLogo from "$lib/logos/linear.svg?raw";
  import { MAIN_DOC_NAME } from "@tex-center/protocol";

  import { WsClient, type WsClientSnapshot } from "$lib/wsClient";
  import { toasts } from "$lib/toastStore";
  import {
    debugEventToToast,
    initDebugFlag,
    onDebugKeyShortcut,
  } from "$lib/debugToasts";
  import {
    EDITOR_FIRST_PDF_SEGMENT,
    EDITOR_FIRST_TEXT_PAINT,
    EDITOR_ROUTE_MOUNTED,
    EDITOR_WS_OPEN,
    EDITOR_YJS_HYDRATED,
    markOnce,
  } from "$lib/editorMarks";

  let { data } = $props();

  let selected = $state<string>(MAIN_DOC_NAME);

  // The CodeMirror editor is mounted only after the per-project
  // sidecar's first authoritative frame (Yjs initial-sync or
  // `file-list`) lands in the local Y.Doc — see GT-A
  // (`verifyLiveGt1NoFlashLoad.spec.ts`). Until then we render
  // a same-dimensioned placeholder so the grid layout doesn't
  // reflow when the editor appears.
  let text = $state<Y.Text | null>(null);

  let snapshot = $state<WsClientSnapshot>({
    status: "connecting",
    pdfBytes: null,
    lastError: null,
    compileState: "unknown",
    files: [MAIN_DOC_NAME],
    fileOpError: null,
    hydrated: false,
  });

  let client: WsClient | null = null;
  let debug = $state(false);
  let detachKey: (() => void) | null = null;

  onMount(() => {
    markOnce(EDITOR_ROUTE_MOUNTED);
    debug = initDebugFlag(
      new URLSearchParams(window.location.search),
      window.localStorage,
    );
    detachKey = onDebugKeyShortcut(
      window,
      () => debug,
      (next) => {
        debug = next;
        window.localStorage.setItem("debug", next ? "1" : "0");
      },
    );
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const projectId = data.project?.id ?? "default";
    const url = `${proto}//${window.location.host}/ws/project/${encodeURIComponent(projectId)}`;
    client = new WsClient({
      url,
      onChange: (s) => {
        snapshot = s;
      },
      onFileOpError: (reason) => {
        toasts.push({
          category: "error",
          text: `File error: ${reason}`,
          aggregateKey: `file-op-error:${reason}`,
        });
      },
      onCompileError: (detail) => {
        toasts.push({
          category: "error",
          text: `Compile error: ${detail}`,
          aggregateKey: `compile-error:${detail}`,
        });
      },
      onDebugEvent: (event) => {
        if (!debug) return;
        toasts.push(debugEventToToast(event));
      },
    });
    text = client.getText(selected);
    // Default until IntersectionObserver fires from PdfViewer.
    client.setViewingPage(1);
  });

  // Switching the selected file rebinds the editor to that file's
  // Y.Text. Every file in the tree is editable; the sidecar
  // persists changes to each file's blob on the next compile.
  $effect(() => {
    if (client) text = client.getText(selected);
  });

  // M13.1 editor-open-latency marks. `markOnce` is idempotent —
  // these fire on the *first* transition through each predicate and
  // are no-ops afterwards (reconnects, file-switches, late frames).
  $effect(() => {
    if (snapshot.status === "open") markOnce(EDITOR_WS_OPEN);
    if (snapshot.hydrated) markOnce(EDITOR_YJS_HYDRATED);
    if (snapshot.pdfBytes !== null) markOnce(EDITOR_FIRST_PDF_SEGMENT);
  });

  // EDITOR_FIRST_TEXT_PAINT fires on the first observed Y.Text with
  // non-empty content. `doc.getText(name)` returns a non-null Y.Text
  // immediately (length=0), so a `text !== null` predicate would
  // fire at +1ms before WS sync — see iter 236 GT-6 timeline. Use
  // a Y.Text observer so the mark aligns with the first content
  // delivered by Yjs sync (or with a file-switch into an already-
  // populated doc).
  $effect(() => {
    if (!text) return;
    if (text.length > 0) {
      markOnce(EDITOR_FIRST_TEXT_PAINT);
      return;
    }
    const yText = text;
    const observer = (): void => {
      if (yText.length > 0) markOnce(EDITOR_FIRST_TEXT_PAINT);
    };
    yText.observe(observer);
    return () => yText.unobserve(observer);
  });

  function handlePageChange(page: number): void {
    client?.setViewingPage(page);
  }

  onDestroy(() => {
    detachKey?.();
    client?.destroy();
  });
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand-group">
      <a href="/projects" class="brand"
        ><span role="img" aria-label="tex.center">{@html linearLogo}</span></a
      >
      <span class="iter">v{PUBLIC_TEXCENTER_ITER || "dev"}</span>
    </div>
    {#if data.user}
      <div class="who">
        <span class="email">{data.user.displayName ?? data.user.email}</span>
        <form method="POST" action="/auth/logout">
          <button type="submit" class="signout">Sign out</button>
        </form>
      </div>
    {/if}
  </header>
  <aside class="tree">
    <FileTree
      files={snapshot.files}
      serverError={snapshot.fileOpError}
      bind:selected
      onCreateFile={(name) => client?.createFile(name)}
      onDeleteFile={(name) => {
        if (selected === name) selected = MAIN_DOC_NAME;
        client?.deleteFile(name);
      }}
      onRenameFile={(oldName, newName) => {
        if (selected === oldName) selected = newName;
        client?.renameFile(oldName, newName);
      }}
      onUploadFile={(name, content) => client?.uploadFile(name, content)}
    />
  </aside>
  <section class="editor">
    {#if snapshot.hydrated && text}
      {#key text}
        <Editor {text} />
      {/key}
    {:else}
      <div class="editor-placeholder" aria-hidden="true"></div>
    {/if}
  </section>
  <section class="preview">
    <PdfViewer src={snapshot.pdfBytes} onPageChange={handlePageChange} />
    {#if snapshot.compileState === "running"}
      <div class="badge">compiling…</div>
    {:else if snapshot.compileState === "error"}
      <div class="badge error">error: {snapshot.lastError}</div>
    {/if}
  </section>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 220px 1fr 1fr;
    grid-template-rows: 36px 1fr;
    grid-template-areas:
      "top top top"
      "tree editor preview";
    height: 100vh;
    width: 100vw;
  }
  .topbar {
    grid-area: top;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    background: #fafafa;
    font-size: 0.85rem;
  }
  .brand-group {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    line-height: 0;
    color: inherit;
    text-decoration: none;
  }
  .brand :global(svg) {
    height: 1.1rem;
    width: auto;
    display: block;
  }
  .brand:hover {
    opacity: 0.75;
  }
  .iter {
    font-size: 0.75rem;
    color: #9ca3af;
  }
  .editor-placeholder {
    width: 100%;
    height: 100%;
    background: white;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .email {
    color: #374151;
  }
  .signout {
    border: 1px solid #d1d5db;
    background: white;
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .signout:hover {
    background: #f3f4f6;
  }
  .tree {
    grid-area: tree;
    border-right: 1px solid #e5e7eb;
    overflow: auto;
  }
  .editor {
    grid-area: editor;
    border-right: 1px solid #e5e7eb;
    overflow: hidden;
    min-width: 0;
  }
  .preview {
    grid-area: preview;
    overflow: auto;
    background: #f3f4f6;
    min-width: 0;
    position: relative;
  }
  .badge {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.25rem 0.5rem;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  .badge.error {
    background: #b91c1c;
  }
</style>
