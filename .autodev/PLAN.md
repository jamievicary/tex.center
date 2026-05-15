# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. Shared-sidecar pool app exists but isn't
routed to (decision deferred post-MVP).

**Active priority queue:**

1. **M22 wire-message debug toasts.** M22.1 closed iter 304 (all
   outbound control sends now emit `outgoing-*` debug events).
   M22.3 closed iter 305 (info TTL 5 s, newest-on-top stack,
   user-dismissible × on info/success). Remaining: M22.2 GT-F
   local Playwright cases (closes M9.editor-ux GT-F); **M22.4a
   UI-only batch and M22.4b wire-shipoutPage batch** queued from
   `306_answer.md` — pick up M22.4a next.
2. **M20 lifecycle (suspend/stop/cold-storage).** M20.1 two-stage
   idle timer closed iter 302; remaining: M20.2 shared `BLOB_STORE`
   binding (sidecar persists source + latex artefacts on every
   settle, rehydrates on cold boot) and M20.3 gold spec. Unblocks
   `verifyLiveGt6LiveEditableStateStopped`.
3. **M21.2 max-visible gold pin.** 3-page PDF + sidecar
   introspection. This is an important feature of tex.center,
   to allow fast incremental compilation when we scroll to
   view additional pages.
4. **M18.2/M18.3 preview-quality follow-ups.** ResizeObserver
   re-render on `.preview` width change + forced-DPR=2 visual
   snapshot. Both deferred until reported.
5. **M11.5a text drop-upload.** Closed iter 306. Wrapping
   `<div class="ft-host">` around the tree's contents accepts
   `dragover` + `drop` for `Files` payloads;
   `classifyDroppedNames(names, files)` mirrors the picker-flow
   `rejectionReason` (trim, `validateProjectFileName`,
   `MAIN_DOC_NAME`, dedup against existing + within-drop), accepted
   names flow through the existing `onUploadFile(name, content)`
   wire path. Locks: `apps/web/test/fileDropUpload.test.mjs`.
6. **M16.aesthetic.** Type pair + 4-colour palette retune for
   chrome surfaces; visual snapshots on `/`, `/projects`, editor
   topbar.
7. **M11.2.** Create/delete/rename via context menu + keyboard.
   **M11.2a closed iter 307** — `F2` rename / `Del`-with-confirm on
   the focused file row. Pure helper `fileTreeKeyboard.ts`. Locks:
   `apps/web/test/fileTreeKeyboard.test.mjs`. Remaining: M11.2b —
   right-click context menu (Create / Rename / Delete entries,
   click-outside + Esc dismissal, keyboard nav within the menu).

**M15 settled (α).** Seeded multi-page case GREEN since iter 295;
no Playwright-reproducible path exhibits the user's page-1-only
bug. Awaiting user-supplied offending source via discussion mode.
No further M15 work without that input.

**Open red specs:**

- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — RED,
  expected, blocked on M20.2.

## 2. Milestones

### M9.editor-ux — live editor UX bugs

Many slices closed (clickable logo, no-flash editor load, compile
coalescer, sustained-typing safety, toast scaffold, toast
consumers for `file-op-error`/compile errors, debug-mode toggle).
See git log + `.autodev/logs/`.

**Frozen contract** — toast store API:
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Remaining slices:

- **GT-E (local Playwright).** info/success/error spawn the right
  toast; repeated `file-op-error` produces a `×N` aggregated badge.
- **GT-F (local Playwright).** `?debug=1` flips localStorage;
  single keystroke produces a green Yjs-op toast and (after
  compile) a blue pdf-segment toast; rapid typing aggregates into
  one green `×N`; without the flag, no debug toasts.
- **Save-feedback affordance.** `SyncStatus` indicator
  (idle/in-flight/error) sourced from Yjs provider sync state
  acked by a sidecar persistence signal (NOT per-keystroke).
  Blocked on a sidecar persistence-ack wire signal that doesn't
  exist yet.

### M11.file-tree — tree component + CRUD UX (post-MVP)

**Constraint (iter 262):** no native-Svelte-5-tree rule; using
`@headless-tree/core` directly with an in-tree Svelte 5 binding.

Closed sub-slices, locks retained:
- M11.1 rendering substrate — `apps/web/src/lib/fileTree.ts`;
  lock `apps/web/test/fileTree.test.mjs`.
- M11.1b slashed paths — `validateProjectFileName` permits
  `/`-separated paths; `LocalFsBlobStore.delete` reaps empty
  parents. Locks: `packages/blobs/test/localFs.test.mjs`,
  `apps/sidecar/test/slashedFileNames.test.mjs`,
  `packages/protocol/test/codec.test.mjs`.
- M11.1c headless cutover — `FileTree.svelte` driven by
  `createFileTreeInstance(forest).getItems()`; `collapsed: Set<\
  string>` tracks user-collapsed folders. Lock:
  `tests_gold/playwright/editor.spec.ts` local case.

Remaining sub-slices:
- **M11.2a** keyboard CRUD — `F2` rename / `Del`-with-confirm /
  `Backspace`-with-confirm on the focused file row. **Closed iter
  307.** Pure helper `apps/web/src/lib/fileTreeKeyboard.ts` exports
  `decideFileRowAction(ev, path, mainDocName) →
  "rename" | "delete" | null` (suppresses modifier keys + the
  `MAIN_DOC_NAME` row, mirroring the inline `✎`/`×` guards).
  `FileTree.svelte` file-row button now has an `onkeydown` that
  dispatches `promptRename` or `window.confirm` + `onDeleteFile`.
  Confirm gate is keyboard-only; the `×` button stays one-click.
  Lock: `apps/web/test/fileTreeKeyboard.test.mjs`.
- **M11.2b** create/delete/rename via right-click context menu.
  Click-outside + Esc dismissal; keyboard nav (arrow keys / Enter)
  within the menu. Same imperative flows as the existing buttons.
- **M11.3** create folder via virtual-folder model.
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5a** OS drop-upload — text files. **Closed iter 306.**
  `apps/web/src/lib/fileDropUpload.ts` exports
  `classifyDroppedNames`; `FileTree.svelte` wraps in
  `<div class="ft-host">` and handles `dragover` / `dragleave` /
  `drop` for `dataTransfer.types` containing `Files`. Visual
  affordance: 2 px dashed `#2563eb` outline-color when isDragOver.
  Lock: `apps/web/test/fileDropUpload.test.mjs`.
- **M11.5b** OS drop-upload — binary assets. Blocked by
  FUTURE_IDEAS "binary asset upload" wire design.
- **M11.5c** drag-out download from tree to OS. Unblocked.

### M12.panels — draggable dividers

**Closed iter 257.** Inline in `+page.svelte` with `--col-tree` /
`--col-preview` CSS custom properties. Per-project widths in
`localStorage["editor-widths:${projectId}"]`. Layout math in
`apps/web/src/lib/editorPanelLayout.ts`. Locks:
`apps/web/test/editorPanelLayout.test.mjs`,
`tests_gold/playwright/editorPanelDividers.spec.ts`.

### M13.open-latency — instrument-then-fix

- **M13.1 instrumentation.** Closed iter 236. Conclusion:
  route→ws-open ~11.5s dominates (cold per-project Machine).
- **M13.2(a) SSR seed gate.** Closed iter 238. `+page.server.ts`
  returns a `seed` when no `machine_assignments` row exists;
  editor renders `<pre class="editor-seed">` until
  `snapshot.hydrated`. **Load-bearing:** seed is visual-only,
  never inserted into the local Y.Doc (CRDT can't dedupe two
  independent `insert(0, …)` ops with different `clientID`);
  placeholder is `<pre>`, not `.cm-content`.
- **M13.2(b).1** no-auto-destroy + self-suspend. Closed iter
  249/250 (resume-bug fix iter 255). Tests:
  `apps/sidecar/test/idleSuspend.test.mjs`.
- **M13.2(b).2** optimistic project delete. Closed iter 254.
  Tests: `apps/web/test/deleteProject.test.mjs`.
- **M13.2(b).3** suspended-resume gold case. GREEN by iter 260.
  Spec: `verifyLiveGt6LiveEditableState.spec.ts`.
- **M13.2(b).4** stopped-state cold-editable pin. RED, expected.
  Spec: `verifyLiveGt6LiveEditableStateStopped.spec.ts`. Target
  for M20.2.
- **M13.2(b).5 R2** landed iter 267. `createIdleHandler` no
  longer exits on `suspendSelf` failure; throw path logs and
  re-arms.

**Open follow-ups for M13.2:**
- `cleanupProjectMachine` re-arms the SSR seed gate even though
  sidecar blob store may still hold the user's edits. Benign
  while blob store is per-Machine; once shared (M20.2), the gate
  must flip from "no machine assignment" to "no persisted blob".
- GT-A passes because it polls `.cm-content` (only appears
  post-hydrate); seed placeholder is a separate DOM element. If
  a future iteration consolidates seed and real editor under one
  `.cm-content`, GT-A's invariant must survive.

### M14.title-bar — centred project title in editor topbar

**Closed iter 264.** `data.project.name` rendered as
`<h1 class="project-title" data-testid="project-title">`. Topbar
grid `1fr auto 1fr`. Lock: editor.spec.ts asserts
|title-centre-x − topbar-centre-x| ≤ 2px.

### M15.multipage-preview — page-1-only PDF bug

Promoted from `241_*`. Sidecar `targetPage=0` fix closed iter
269 (`tests_gold/cases/test_supertex_multipage_emit.py` GREEN).

**Settled at project level (α outcome).** Three Playwright pins
all GREEN: `verifyLivePdfMultiPage` static, in-body manual edit,
and `verifyLivePdfMultiPageSeeded` (zero-edit seeded path,
GREEN since iter 295 first live run). No reproducible path
exhibits the user-reported page-1-only bug. Most likely
remaining cause: content-specific (a package / math env /
figure in the user's actual main.tex). Awaiting user-supplied
offending source via discussion mode; no further M15 work
without it.

**Frozen seed-doc plumbing (M15 Step D, landed iter 292):**
- `packages/db/src/migrations/0003_add_projects_seed_doc.sql`
  adds `projects.seed_doc text NULL`.
- `createProject({ ..., seedMainDoc })` persists; `getProject\
  SeedDoc(db, id)` reads back.
- `apps/web/src/lib/server/upstreamResolver.ts` accepts
  `seedDocFor: (id) => Promise<string|null>`; non-null →
  `env.SEED_MAIN_DOC_B64=<base64>` on Machine create.
- `apps/sidecar/src/server.ts` decodes the env var; passes
  through to `createProjectPersistence({ seedMainDoc })`. Only
  used when no `main.tex` blob exists yet — never clobbers
  persisted content.

`test_supertex_incremental_multipage_emit.py` retained as
shape-baseline normal test.

### M18.preview-quality — DPR-aware PDF rendering

- **M18.1 DPR-aware backing store.** Closed iter 295.
  `apps/web/src/lib/pdfRenderScale.ts`; `PdfViewer.svelte` reads
  `window.devicePixelRatio` per commit, renders at `pixelScale`,
  hands `cssScale` to fade controller. Lock:
  `apps/web/test/pdfRenderScale.test.mjs`.
- **M18.2 (open).** ResizeObserver on `.preview` re-renders on
  width change (coalesced trailing 100ms). Deferred until
  reported.
- **M18.3 (open).** Gold visual-snapshot pin under
  `deviceScaleFactor: 2`. Defer until Playwright snapshot infra
  grows a stable comparison primitive (M16.aesthetic also needs
  this).

### M19.settings — settings dialog + email in topbar

**Closed iter 297/298.** Cog button in editor topbar, left of
email/sign-out. Popover (not modal). Slider: fade-duration
0–3000ms step 50ms, default 180ms. Persisted via
`localStorage["editor-settings"]` (single JSON object — one key
for all future settings). Applied live via `--pdf-fade-ms` CSS
custom property on `.shell`. Topbar shows `email` (was
`displayName ?? email`). Escape closes popover and refocuses
cog; opening focuses the slider. Locks:
`apps/web/test/settingsStore.test.mjs`,
`tests_gold/playwright/editor.spec.ts` (three-panel-layout
case asserts topbar email shape + cog↔Esc round-trip).

### M20.lifecycle — suspend → stop → cold-storage cascade

From `293_answer.md` (4). Two-tier idle cascade with full
cold-storage. Absorbs the former M13.2(b).5 R1.

Slices:
- **M20.1** two-stage idle timer in sidecar. **Closed iter 302.**
  `SidecarOptions` exposes independent `suspendTimeoutMs`+`onSuspend`
  and `stopTimeoutMs`+`onStop`; both arm on `viewerCount→0` (and on
  cold boot until first viewer), both clear on first re-connect.
  `index.ts::createSuspendHandler` calls the Fly machines-API
  `/suspend` and re-arms whether the POST succeeds (post-resume) or
  fails (R2 stays soft); `index.ts::createStopHandler` closes the app
  and exits 0 (the only path to `stopped` from idle). Checkpoint
  persist runs before both handlers. Env wiring:
  `SIDECAR_SUSPEND_MS` (default 5_000), `SIDECAR_STOP_MS` (default
  300_000) — both overridable for M20.3 gold-spec timing. Locks:
  `apps/sidecar/test/idleSuspend.test.mjs`,
  `apps/sidecar/test/serverIdleStop.test.mjs`,
  `apps/sidecar/test/serverCheckpointWiring.test.mjs`.
- **M20.2** shared `BLOB_STORE` binding on web tier *and*
  sidecar. Sidecar persists source + latex compilation artefacts (but NOT supertex outputs)to blob store on every settle. Rehydrate on cold boot.
  Unblocks `verifyLiveGt6LiveEditableStateStopped`.
- **M20.3** gold spec exercising the full cycle: open project,
  idle 6 s (suspended), edit → 300 ms ack; idle 6 min
  (stopped), edit → cold-start budget; content preserved across
  both. However this gold test would take too long, so can we overrule the 6 min long-stop timer for test purpose please.

Tuning note: 5 s suspend is aggressive but suspend cost is
~300 ms reconnect. Adjust via env vars if live use shows thrash.

### M21.target-page — max-visible-page wire signal

GOAL item 4 needs *max-visible* so sidecar compiles every page
the user can see.

- **M21.1 max-visible logic + wire switch.** Closed iter 296.
  `pickMaxVisible(items)` + `PageTracker.update()` widened to
  `{ mostVisible, maxVisible }`; `PdfViewer.svelte` IO callback
  sends `maxVisible` via `client.setViewingPage`. Sidecar
  `maxViewingPage(p)` reducer unchanged. Lock:
  `apps/web/test/pageTracker.test.mjs`.
- **M21.2 (open).** Gold spec: 3-page PDF, scroll so page 2
  fully visible and page 3's top edge intrudes → sidecar
  receives target=3. Needs real 3-page Playwright source plus a
  sidecar introspection hook.

### M22.debug-toasts.b — front→back wire coverage

From `293_answer.md` (7,8). Closes M9.editor-ux GT-F. M22.4
batch added iter 308 from `306_answer.md`.

Slices:
- **M22.1** Closed iter 304. `WsDebugEvent` extended with
  `outgoing-viewing-page`, `outgoing-create-file`,
  `outgoing-upload-file`, `outgoing-delete-file`,
  `outgoing-rename-file`; each emitted only when the underlying
  `send()` returned true (pre-open silence convention). All map to
  `debug-green` via `debugEventToToast`, shared aggregateKey per
  kind. `recompile-request` is not on the list — the web client
  never sends one; recompile is server-driven from a `doc-update`.
  Lock: `apps/web/test/wsClientDebugEvents.test.mjs` case 9 + the
  expanded toast-mapping matrix in case 7.
- **M22.2** finish GT-F local Playwright cases.
- **M22.3** Closed iter 305. Three UX changes in
  `apps/web/src/lib/`:
  - `toastStore.ts` `DEFAULT_TTL_MS.info` `4_000 → 5_000`.
  - `Toasts.svelte` subscribe handler reverses the store array so
    newest renders at the top of the flex-column stack;
    aggregating pushes still update the existing toast in place.
  - `Toasts.svelte` dismiss-button guard widened from
    `t.persistent` to also fire on
    `t.category === "info" || t.category === "success"`.
    Error stays auto-dismiss-only (6 s).
  Locks: `apps/web/test/toastStore.test.mjs` case 2 (info-at-5s,
  error-at-6s); case 5 also pins the store's oldest-first
  insertion order, which the renderer reverses.
- **M22.4a (UI-only, no wire change).** From `306_answer.md`.
  Items 1–6 plus item 9-as-`compile-status`-elapsed. Concretely:
  - `settingsStore` gains `debugMode: boolean` (default `true`);
    `FADE_MS_DEFAULT` 180 → 1000.
  - `initDebugFlag` migrates one-shot from `localStorage["debug"]`
    into `editor-settings.debugMode`, then deletes the old key.
  - `Settings.svelte` adds a debug-mode checkbox above the slider;
    URL `?debug=1/0` and Ctrl+Shift+D write the same setting.
  - All `debug-*` TTLs bumped from 2 s (red: 4 s) → 10 s in
    `toastStore.DEFAULT_TTL_MS`. Info/success/error unchanged.
  - `Toasts.svelte` keyed each gains `animate:flip` with
    `{ duration: 500, easing: cubicOut }` for vertical reflow.
  - New `apps/web/src/lib/compileCycleTracker.ts` (pure, injectable
    clock). Wraps `debugEventToToast` only for `compile-status`
    events; `running` resets the timer, `idle`/`error` prefix the
    toast text with `${elapsed}s — `.
  - Locks: `apps/web/test/settingsStore.test.mjs`,
    `apps/web/test/toastStore.test.mjs`,
    `apps/web/test/compileCycleTracker.test.mjs` (new),
    `apps/web/test/debugToasts.test.mjs`.
- **M22.4b (wire change).** From `306_answer.md` items 7, 8.
  - `packages/protocol/src/index.ts`: `PdfSegment.shipoutPage?:
    number`; binary header 13 → 17 bytes, new `uint32` after
    `bytesLength`. 0 sentinel = unknown.
    `encodePdfSegment` / `decodeFrame` updated; codec tests updated.
  - `apps/sidecar/src/compiler/supertexDaemon.ts:177` stamps the
    assembled segment with `shipoutPage: events.maxShipout`.
  - `apps/sidecar/src/server.ts:544` passes the segment through
    unchanged (the encoder reads `seg.shipoutPage`).
  - `WsDebugEvent.pdf-segment` carries `shipoutPage`;
    `debugEventToToast` formats
    `[${n}.out] ${bytes} bytes` when known, falls back to
    `${bytes} bytes` when 0/missing.
  - Compile-cycle tracker also prefixes the segment toast with
    `${elapsedMs}s — ` (item 7 full coverage).
  - Locks: `packages/protocol/test/codec.test.mjs` (header-width
    case), `apps/sidecar/test/supertexDaemon.test.mjs` if it
    asserts the segment shape, `apps/web/test/debugToasts.test.mjs`
    page-name case, `apps/web/test/wsClientDebugEvents.test.mjs`
    if it pins the WsDebugEvent shape.

### M17.preview-render — PDF preview cross-fade

**Closed iter 271/273.** `apps/web/src/lib/pdfFadeController.ts`
owns per-page fade state machine. `PdfViewer.svelte` renders
pages off-DOM, hands per-page canvas descriptors to the
controller; wrappers carry `data-page` for stable IntersectionObserver
targets. Locks: `apps/web/test/pdfFadeController.test.mjs`,
`verifyLivePdfNoFlashBetweenSegments.spec.ts`.

### M17.b — cross-fade blend math

**Closed iter 299.** Single-layer-opacity strategy (entering
canvas under at opacity 1; leaving canvas above, fades 1→0)
gives `(1−t)·OLD + t·NEW` with no `BG` term — no mid-fade
bleed-through. `CROSS_FADE_STRATEGY` constant +
`crossFadeAt(t, old, new, bg)` helper in
`apps/web/src/lib/pdfCrossFade.ts`. `PdfViewer.svelte` adapter
extracted to `apps/web/src/lib/pdfFadeAdapter.ts` (iter 300).
Lock: `apps/web/test/pdfCrossFade.test.mjs` (flat-grey invariant,
linear-interpolation property, legacy-strategy regression guard).

**Unpinned branch:** `fadeOutAndRemoveWrapper` (commit-with-fewer-
pages, e.g. typing `\end{document}` mid-doc to drop trailing
pages). Not on the active queue; add a live-side pin if a
regression surfaces.

### M16.aesthetic — writerly chrome retune

Retune site CSS for chrome surfaces (landing, dashboard, editor
topbar/tree/status). Editor and PDF content surfaces stay
strictly functional.

- **Type pair:** Source Serif 4 (body / project names / hero
  prose; OFL, variable) + Inter (UI affordances; OFL, variable).
  Self-host both. Monospace in CodeMirror pane unchanged.
- **Palette (4 colours):** Paper `#FAF7F0` + Ink `#1F1B16` +
  Quill `#2E4C6D` (accent / links / primary buttons) + Margin
  `#D9CFBF` (rules, dividers, chevron tints).
- **Pin:** Playwright visual-snapshot diff on `/` and
  `/projects`, plus tight topbar-element snapshot on editor.
  Requires the same snapshot primitive as M18.3.

### M8.pw.3.3 — real-OAuth-callback live activation

Code complete. Operator-gated: create test OAuth client in GCP
(redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push `TEST_OAUTH_BYPASS_KEY`
to Fly secrets. Then `verifyLiveOauthCallback.spec.ts` un-skips.

### M7.5 — daemon-adoption hardening

Rate limits, observability surface, narrower deploy tokens.
**Deferred**, post-MVP.

### Completed

M0–M7.5.5; M8.smoke.0; M8.pw.0–M8.pw.4-reused; M9.observability;
M9.cold-start-retry; M9.resource-hygiene; M9.gold-restructure;
M10.branding; M11.1/1b/1c; M12; M13.1; M13.2(a); M13.2(b).1–3,
.5 R2; M14; M15 sidecar fix; M15 Step D plumbing; M17; M17.b
math + adapter extraction; M18.1; M19; M21.1; iter-200
coalescer extraction; iter-258/259 boot-time session sweep;
iter-280 layout math extraction + iter-290 dead-branch removal;
iter-293 startup `pw-*` sweep + machine-count threshold bump.

See git log and `.autodev/logs/` for narrative detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:
true` paired with an explicit kill before iteration end. Never
pipe such a command into a downstream that waits for EOF
(`… | tail -N`, `… | head`) — that pipeline shape wedged
iter 148.
