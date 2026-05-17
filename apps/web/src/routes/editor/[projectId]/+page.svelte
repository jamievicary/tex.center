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
    initDebugMode,
    onDebugKeyShortcut,
  } from "$lib/debugToasts";
  import { createCompileCycleTracker } from "$lib/compileCycleTracker";
  import {
    EDITOR_FIRST_PDF_SEGMENT,
    EDITOR_FIRST_TEXT_PAINT,
    EDITOR_ROUTE_MOUNTED,
    EDITOR_WS_OPEN,
    EDITOR_YJS_HYDRATED,
    markOnce,
  } from "$lib/editorMarks";
  import {
    DEFAULT_TREE_PX,
    DIVIDER_PX,
    clampPanelWidths,
    parseStoredWidths,
    serializeWidths,
    widthsStorageKey,
  } from "$lib/editorPanelLayout";
  import {
    DEFAULT_SETTINGS,
    FADE_MS_MAX,
    FADE_MS_MIN,
    FADE_MS_STEP,
    SETTINGS_STORAGE_KEY,
    clampFadeMs,
    parseSettings,
    serializeSettings,
    type EditorSettings,
  } from "$lib/settingsStore";

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
    pdfLastPage: undefined,
    dirtyFromPage: null,
    lastError: null,
    compileState: "unknown",
    files: [MAIN_DOC_NAME],
    fileOpError: null,
    hydrated: false,
  });

  let client: WsClient | null = null;
  let detachKey: (() => void) | null = null;
  const compileCycle = createCompileCycleTracker();

  onMount(() => {
    markOnce(EDITOR_ROUTE_MOUNTED);
    detachKey = onDebugKeyShortcut(
      window,
      () => settings.debugMode,
      (next) => {
        setDebugMode(next);
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
        if (!settings.debugMode) {
          // Tracker still observes so cycle bookkeeping stays in
          // sync with the wire even while toasts are muted.
          compileCycle.observe(event);
          return;
        }
        toasts.push(compileCycle.observe(event));
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

  // M12: draggable panel dividers. Three columns — tree, editor,
  // preview. Pure layout math lives in `$lib/editorPanelLayout`;
  // this component owns the $state, DOM wiring, and localStorage
  // I/O. Widths persist per-project so reload restores the user's
  // last drag position.
  let treePx = $state(DEFAULT_TREE_PX);
  let previewPx = $state<number | null>(null);
  let shellEl: HTMLDivElement | null = $state(null);

  function storageKey(): string | null {
    const id = data.project?.id;
    return id ? widthsStorageKey(id) : null;
  }

  function loadWidths(): void {
    const key = storageKey();
    if (!key) return;
    const raw = window.localStorage.getItem(key);
    const parsed = parseStoredWidths(raw);
    if (parsed.tree !== undefined) treePx = parsed.tree;
    if (parsed.preview !== undefined) previewPx = parsed.preview;
  }

  function persistWidths(): void {
    const key = storageKey();
    if (!key || previewPx === null) return;
    try {
      window.localStorage.setItem(
        key,
        serializeWidths({ tree: treePx, preview: previewPx }),
      );
    } catch {
      // Quota or disabled — silently drop.
    }
  }

  function shellWidth(): number {
    return shellEl?.getBoundingClientRect().width ?? window.innerWidth;
  }

  function clampWidths(): void {
    const clamped = clampPanelWidths({
      tree: treePx,
      preview: previewPx,
      total: shellWidth(),
    });
    treePx = clamped.tree;
    previewPx = clamped.preview;
  }

  type DragKind = "tree" | "preview";
  let dragging: DragKind | null = null;
  let dragStartX = 0;
  let dragStartValue = 0;

  function onDividerPointerDown(kind: DragKind, e: PointerEvent): void {
    if (e.button !== 0) return;
    dragging = kind;
    dragStartX = e.clientX;
    dragStartValue = kind === "tree" ? treePx : (previewPx ?? 0);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onDividerPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (dragging === "tree") {
      treePx = dragStartValue + dx;
    } else {
      previewPx = dragStartValue - dx;
    }
    clampWidths();
  }

  function onDividerPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    persistWidths();
  }

  onMount(() => {
    loadWidths();
    clampWidths();
    const onResize = () => clampWidths();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // M19: editor settings (cog popover). Stored as a single JSON
  // blob in localStorage["editor-settings"]; parseSettings clamps
  // and falls back to defaults so malformed storage can't break
  // the editor. Hydrated in onMount because localStorage is
  // browser-only.
  let settings = $state<EditorSettings>({ ...DEFAULT_SETTINGS });
  let settingsOpen = $state(false);
  let settingsCogEl: HTMLButtonElement | null = $state(null);
  let settingsSliderEl: HTMLInputElement | null = $state(null);

  function persistSettings(): void {
    try {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        serializeSettings(settings),
      );
    } catch {
      // Quota or disabled — silently drop.
    }
  }

  function updateFadeMs(ms: number): void {
    const clamped = clampFadeMs(ms);
    settings = { ...settings, fadeMs: clamped };
    persistSettings();
  }

  function setDebugMode(next: boolean): void {
    settings = { ...settings, debugMode: next };
    persistSettings();
  }

  function toggleSettings(): void {
    settingsOpen = !settingsOpen;
  }

  function onSettingsOutsidePointerDown(e: PointerEvent): void {
    if (!settingsOpen) return;
    const target = e.target as Node | null;
    if (!target) return;
    const popover = document.querySelector(".settings-popover");
    const cog = document.querySelector(".settings-cog");
    if (popover?.contains(target)) return;
    if (cog?.contains(target)) return;
    settingsOpen = false;
  }

  function onSettingsKeydown(e: KeyboardEvent): void {
    if (!settingsOpen) return;
    if (e.key !== "Escape") return;
    settingsOpen = false;
    settingsCogEl?.focus();
    e.preventDefault();
  }

  // M19.3: when the popover opens, move keyboard focus into it
  // (first interactive control = the fade slider). Svelte 5 flushes
  // the `{#if settingsOpen}` block before this effect re-runs, so
  // `settingsSliderEl` is non-null on the same tick the open
  // transitions to true.
  $effect(() => {
    if (settingsOpen) settingsSliderEl?.focus();
  });

  onMount(() => {
    settings = parseSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY));
    // Resolve initial debug mode: URL `?debug=` > legacy
    // `localStorage["debug"]` migration > persisted setting. The
    // helper removes the legacy key as a side effect on first read.
    const resolved = initDebugMode(
      new URLSearchParams(window.location.search),
      window.localStorage,
      settings.debugMode,
    );
    if (resolved.debug !== settings.debugMode) {
      settings = { ...settings, debugMode: resolved.debug };
    }
    if (resolved.shouldPersist) persistSettings();
    window.addEventListener("pointerdown", onSettingsOutsidePointerDown);
    window.addEventListener("keydown", onSettingsKeydown);
    return () => {
      window.removeEventListener("pointerdown", onSettingsOutsidePointerDown);
      window.removeEventListener("keydown", onSettingsKeydown);
    };
  });

  onDestroy(() => {
    detachKey?.();
    client?.destroy();
  });
</script>

<div
  class="shell"
  bind:this={shellEl}
  style="--col-tree: {treePx}px;{previewPx !== null
    ? ` --col-preview: ${previewPx}px;`
    : ''} --pdf-fade-ms: {settings.fadeMs}ms;"
>
  <header class="topbar">
    <div class="brand-group">
      <a href="/projects" class="brand"
        ><span role="img" aria-label="tex.center">{@html linearLogo}</span></a
      >
      <span class="iter">v{PUBLIC_TEXCENTER_ITER || "dev"}</span>
    </div>
    {#if data.project}
      <h1 class="project-title" data-testid="project-title">
        {data.project.name}
      </h1>
    {:else}
      <span></span>
    {/if}
    {#if data.user}
      <div class="who">
        <button
          type="button"
          class="settings-cog"
          aria-label="Editor settings"
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          data-testid="settings-cog"
          bind:this={settingsCogEl}
          onclick={toggleSettings}
        >
          <!-- Inline cog glyph; 16px, currentColor stroke so it
               tracks the topbar text colour. No external asset. -->
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3"></circle>
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            ></path>
          </svg>
        </button>
        <span class="email" data-testid="topbar-email">{data.user.email}</span>
        <form method="POST" action="/auth/logout">
          <button type="submit" class="signout">Sign out</button>
        </form>
      </div>
    {/if}
  </header>
  {#if settingsOpen}
    <div
      class="settings-popover"
      role="dialog"
      aria-label="Editor settings"
      data-testid="settings-popover"
    >
      <label class="settings-row">
        <span class="settings-label">Debug toasts</span>
        <input
          type="checkbox"
          checked={settings.debugMode}
          data-testid="settings-debug-mode"
          onchange={(e) =>
            setDebugMode((e.currentTarget as HTMLInputElement).checked)}
        />
      </label>
      <label class="settings-row">
        <span class="settings-label">PDF cross-fade duration</span>
        <input
          type="range"
          min={FADE_MS_MIN}
          max={FADE_MS_MAX}
          step={FADE_MS_STEP}
          value={settings.fadeMs}
          data-testid="settings-fade-ms"
          bind:this={settingsSliderEl}
          oninput={(e) =>
            updateFadeMs(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="settings-value" data-testid="settings-fade-ms-value"
          >{(settings.fadeMs / 1000).toFixed(2)}s</span
        >
      </label>
    </div>
  {/if}
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
  <div
    class="divider divider-tree"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize file tree"
    data-divider="tree"
    onpointerdown={(e) => onDividerPointerDown("tree", e)}
    onpointermove={onDividerPointerMove}
    onpointerup={onDividerPointerUp}
  ></div>
  <section class="editor">
    {#if snapshot.hydrated && text}
      {#key text}
        <Editor {text} />
      {/key}
    {:else if data.seed && selected === data.seed.name}
      <!-- M13.2(a): render the canonical seed text inside the
           `.editor` pane while the per-project sidecar cold-starts
           (~11.5 s on live, per iter-236 GT-6 timeline). This is a
           visual seed only — the local Y.Doc stays empty until WS
           hydrate lands, so the CRDT cannot duplicate the sidecar's
           identical seed when initial sync arrives. The placeholder
           deliberately does *not* carry the `.cm-content` class:
           live specs that click/type into `.cm-content` (e.g.
           verifyLiveFullPipeline.spec.ts) must continue to wait for
           the real CodeMirror mount before interacting; the
           `.editor` pane is what tests should poll for
           seed-content appearance (see GT-6). -->
      <pre class="editor-seed" aria-hidden="true">{data.seed.text}</pre>
    {:else}
      <div class="editor-placeholder" aria-hidden="true"></div>
    {/if}
  </section>
  <div
    class="divider divider-preview"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize PDF preview"
    data-divider="preview"
    onpointerdown={(e) => onDividerPointerDown("preview", e)}
    onpointermove={onDividerPointerMove}
    onpointerup={onDividerPointerUp}
  ></div>
  <section class="preview">
    <PdfViewer
      src={snapshot.pdfBytes}
      lastPage={snapshot.pdfLastPage}
      dirtyFromPage={snapshot.dirtyFromPage}
      onPageChange={handlePageChange}
    />
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
    position: relative;
    /* M12: tree/preview hold absolute px via custom properties;
       editor takes the remaining 1fr. When --col-preview is 0
       (pre-mount, before clampWidths runs) we degrade gracefully
       to 1fr so the layout still renders. */
    grid-template-columns:
      var(--col-tree, 220px) 4px 1fr 4px
      minmax(0, var(--col-preview, 1fr));
    grid-template-rows: 36px 1fr;
    grid-template-areas:
      "top top top top top"
      "tree dtree editor dpreview preview";
    height: 100vh;
    width: 100vw;
  }
  .divider {
    background: #e5e7eb;
    cursor: col-resize;
    user-select: none;
    touch-action: none;
  }
  .divider:hover,
  .divider:active {
    background: #9ca3af;
  }
  .divider-tree {
    grid-area: dtree;
  }
  .divider-preview {
    grid-area: dpreview;
  }
  .topbar {
    grid-area: top;
    display: grid;
    /* M14: three columns (1fr auto 1fr) so the centred title is
       mathematically centred within the topbar regardless of the
       (small) widths of brand-group and the who-group. */
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    background: #fafafa;
    font-size: 0.85rem;
    gap: 0.75rem;
  }
  .project-title {
    margin: 0;
    justify-self: center;
    font-size: 0.9rem;
    font-weight: 500;
    color: #1f2937;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    max-width: 100%;
  }
  .brand-group {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    justify-self: start;
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
  .editor-seed {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0.5rem;
    background: white;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.4;
    color: #1f2937;
    white-space: pre;
    overflow: auto;
    box-sizing: border-box;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    justify-self: end;
  }
  .settings-cog {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: 1px solid transparent;
    background: transparent;
    color: #4b5563;
    border-radius: 4px;
    cursor: pointer;
    line-height: 0;
  }
  .settings-cog:hover {
    background: #f3f4f6;
    border-color: #d1d5db;
  }
  .settings-cog[aria-expanded="true"] {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .settings-popover {
    position: absolute;
    top: 36px;
    right: 0.75rem;
    z-index: 10;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    padding: 0.75rem;
    min-width: 260px;
    font-size: 0.8rem;
  }
  .settings-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }
  .settings-row input[type="range"] {
    width: 100%;
  }
  .settings-label {
    color: #374151;
    font-weight: 500;
  }
  .settings-value {
    color: #6b7280;
    justify-self: end;
    font-variant-numeric: tabular-nums;
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
