# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. Shared-sidecar pool app exists but isn't
routed to (decision deferred post-MVP).

**Active priority queue:**

1. **M23 workspace file mirroring** (queued iter 310 from
   `309_answer.md` item 2). Today `apps/sidecar/src/workspace.ts`
   only writes `main.tex`; auxiliary files (`addFile`/`upload-file`)
   live only in Yjs/blob storage and never reach the on-disk
   workspace dir the supertex daemon spawns in, so `\input{sec1}`
   cannot resolve. Categorical product regression — ranks above
   M20.2 / M21.2 / M22.x perf work. See M23 section below.
2. **M22 remaining slices.** M22.2 GT-F local Playwright cases
   (closes M9.editor-ux GT-F); M22.4b wire-shipoutPage batch
   (header 13 → 17 bytes, `PdfSegment.shipoutPage?`).
3. **M20 lifecycle.** M20.2 shared `BLOB_STORE` (sidecar persists
   source + latex artefacts on every settle, rehydrates on cold
   boot) and M20.3 gold spec. Unblocks
   `verifyLiveGt6LiveEditableStateStopped`.
4. **M21.2 max-visible gold pin.** 3-page PDF + sidecar
   introspection. Fast incremental compilation when scrolling.
5. **M21.3 page-prefetch off-by-one investigation** (queued iter
   310 from `309_answer.md` item 3). User reports "edit on page
   N+1 still ships a segment". Today there is no target-page gate
   (`server.ts:528` hard-codes `targetPage: 0` → `recompile,end`),
   so the emit decision is in supertex's own checkpoint engine.
   M21.3a tightens `pickMaxVisible` (stricter visibility
   threshold); M21.3b extends `daemon-stdin` debug log with
   `maxShipout` / `errorReason`; M21.3c files upstream repro if
   needed.
6. **M18.2 / M18.3 preview-quality follow-ups.** ResizeObserver
   re-render on `.preview` width change + forced-DPR=2 visual
   snapshot. Deferred until reported.
7. **M16.aesthetic.** Type pair + 4-colour palette retune for
   chrome surfaces; visual snapshots on `/`, `/projects`, editor
   topbar. Blocked on Playwright stable snapshot primitive.
8. **M11.2b right-click context menu** (Create / Rename / Delete,
   click-outside + Esc, keyboard nav).

**M15 settled (α).** Seeded multi-page case GREEN since iter 295;
no Playwright-reproducible path exhibits the user's page-1-only
bug. Awaiting user-supplied offending source via discussion mode.

**Open red specs:**

- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — RED,
  expected, blocked on M20.2.

## 2. Milestones

### M9.editor-ux — live editor UX bugs

Frozen contract — toast store API:
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500 ms re-arms TTL and bumps `count`.

Remaining slices:

- **GT-E (local Playwright).** info/success/error spawn the right
  toast; repeated `file-op-error` produces a `×N` aggregated badge.
- **GT-F (local Playwright).** `?debug=1` flips localStorage;
  single keystroke produces a green Yjs-op toast and (after
  compile) a blue pdf-segment toast; rapid typing aggregates into
  one green `×N`; without the flag, no debug toasts.
- **Save-feedback affordance.** `SyncStatus` indicator
  (idle/in-flight/error) sourced from Yjs provider sync state
  acked by a sidecar persistence signal. Blocked on a sidecar
  persistence-ack wire signal that doesn't exist yet.

### M11.file-tree — tree component + CRUD UX (post-MVP)

**Constraint (iter 262):** no native-Svelte-5-tree rule; using
`@headless-tree/core` directly with an in-tree Svelte 5 binding.

Closed sub-slices, locks retained:
- M11.1 rendering substrate — lock `apps/web/test/fileTree.test.mjs`.
- M11.1b slashed paths — `validateProjectFileName` permits
  `/`-separated paths; `LocalFsBlobStore.delete` reaps empty
  parents. Locks: `packages/blobs/test/localFs.test.mjs`,
  `apps/sidecar/test/slashedFileNames.test.mjs`,
  `packages/protocol/test/codec.test.mjs`.
- M11.1c headless cutover — lock
  `tests_gold/playwright/editor.spec.ts` local case.
- M11.2a keyboard CRUD (iter 307) — pure helper
  `apps/web/src/lib/fileTreeKeyboard.ts`; lock
  `apps/web/test/fileTreeKeyboard.test.mjs`.
- M11.5a text drop-upload (iter 306) — pure helper
  `apps/web/src/lib/fileDropUpload.ts`; lock
  `apps/web/test/fileDropUpload.test.mjs`.

Remaining sub-slices:
- **M11.2b** create/delete/rename via right-click context menu.
  Click-outside + Esc dismissal; keyboard nav (arrow keys / Enter)
  within the menu. Same imperative flows as existing buttons.
- **M11.3** create folder via virtual-folder model.
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5b** OS drop-upload — binary assets. Blocked by
  FUTURE_IDEAS "binary asset upload" wire design.
- **M11.5c** drag-out download from tree to OS. Unblocked.

### M12.panels — draggable dividers

**Closed iter 257.** Locks:
`apps/web/test/editorPanelLayout.test.mjs`,
`tests_gold/playwright/editorPanelDividers.spec.ts`.

### M13.open-latency — instrument-then-fix

- **M13.1 instrumentation** (iter 236). Conclusion: route→ws-open
  ~11.5 s dominates (cold per-project Machine).
- **M13.2(a) SSR seed gate** (iter 238). **Load-bearing:** seed
  is visual-only, never inserted into the local Y.Doc (CRDT can't
  dedupe two independent `insert(0, …)` ops with different
  `clientID`); placeholder is `<pre class="editor-seed">`, not
  `.cm-content`.
- **M13.2(b).1** no-auto-destroy + self-suspend (iter 249/250;
  resume fix iter 255). Lock:
  `apps/sidecar/test/idleSuspend.test.mjs`.
- **M13.2(b).2** optimistic project delete (iter 254). Lock:
  `apps/web/test/deleteProject.test.mjs`.
- **M13.2(b).3** suspended-resume gold case — GREEN by iter 260.
  Spec: `verifyLiveGt6LiveEditableState.spec.ts`.
- **M13.2(b).4** stopped-state cold-editable pin — RED, expected.
  Spec: `verifyLiveGt6LiveEditableStateStopped.spec.ts`. Target
  for M20.2.
- **M13.2(b).5 R2** (iter 267). `createIdleHandler` no longer
  exits on `suspendSelf` failure; throw path logs and re-arms.

**Open follow-ups:**
- `cleanupProjectMachine` re-arms the SSR seed gate even though
  sidecar blob store may still hold the user's edits. Benign
  while blob store is per-Machine; once shared (M20.2), the gate
  must flip from "no machine assignment" to "no persisted blob".
- GT-A polls `.cm-content` (only appears post-hydrate); seed
  placeholder is a separate DOM element. If a future iteration
  consolidates seed and real editor under one `.cm-content`,
  GT-A's invariant must survive.

### M14.title-bar — centred project title

**Closed iter 264.** Topbar grid `1fr auto 1fr`; lock asserts
|title-centre-x − topbar-centre-x| ≤ 2 px.

### M15.multipage-preview — settled (α)

Sidecar `targetPage=0` fix closed iter 269. Three Playwright pins
all GREEN. No reproducible path exhibits the user-reported
page-1-only bug; awaiting user source via discussion mode.

**Frozen seed-doc plumbing (Step D, iter 292):**
- `packages/db/src/migrations/0003_add_projects_seed_doc.sql`
  adds `projects.seed_doc text NULL`.
- `createProject({ ..., seedMainDoc })` persists;
  `getProjectSeedDoc(db, id)` reads back.
- `apps/web/src/lib/server/upstreamResolver.ts` accepts
  `seedDocFor: (id) => Promise<string|null>`; non-null →
  `env.SEED_MAIN_DOC_B64=<base64>` on Machine create.
- `apps/sidecar/src/server.ts` decodes; passes to
  `createProjectPersistence({ seedMainDoc })`. Only used when no
  `main.tex` blob exists yet — never clobbers persisted content.

`test_supertex_incremental_multipage_emit.py` retained as
shape-baseline normal test.

### M17.preview-render — PDF preview cross-fade

**Closed iter 271/273.** `apps/web/src/lib/pdfFadeController.ts`
owns per-page fade state machine. Locks:
`apps/web/test/pdfFadeController.test.mjs`,
`verifyLivePdfNoFlashBetweenSegments.spec.ts`.

### M17.b — cross-fade blend math

**Closed iter 299/300.** Single-layer-opacity strategy
(entering canvas under at opacity 1; leaving canvas above, fades
1→0) gives `(1−t)·OLD + t·NEW` with no `BG` term. Helpers in
`apps/web/src/lib/pdfCrossFade.ts` and
`apps/web/src/lib/pdfFadeAdapter.ts`. Lock:
`apps/web/test/pdfCrossFade.test.mjs`.

**Unpinned branch:** `fadeOutAndRemoveWrapper` (commit-with-fewer-
pages). Add a live-side pin if a regression surfaces.

### M18.preview-quality — DPR-aware PDF rendering

- **M18.1 DPR-aware backing store** (iter 295). Lock:
  `apps/web/test/pdfRenderScale.test.mjs`.
- **M18.2 (open).** ResizeObserver on `.preview` re-renders on
  width change (coalesced trailing 100 ms). Deferred until
  reported.
- **M18.3 (open).** Gold visual-snapshot pin under
  `deviceScaleFactor: 2`. Defer until Playwright stable snapshot
  primitive exists (M16.aesthetic shares the blocker).

### M19.settings — settings dialog + email

**Closed iter 297/298.** Cog button in editor topbar, left of
email/sign-out. Popover (not modal). Per-setting JSON in
`localStorage["editor-settings"]` (single object — one key for all
future settings). Applied live via `--pdf-fade-ms` CSS custom
property. Locks: `apps/web/test/settingsStore.test.mjs`;
`editor.spec.ts` three-panel-layout case asserts topbar email +
cog↔Esc round-trip.

### M20.lifecycle — suspend → stop → cold-storage

From `293_answer.md` (4). Two-tier idle cascade with full
cold-storage.

- **M20.1** two-stage idle timer (iter 302). `SidecarOptions` has
  independent `suspendTimeoutMs`/`onSuspend` and
  `stopTimeoutMs`/`onStop`; both arm on `viewerCount→0` and on
  cold boot until first viewer. `createSuspendHandler` calls Fly
  `/suspend` and re-arms whether POST succeeds or fails;
  `createStopHandler` closes the app and exits 0. Checkpoint
  persist runs before both handlers. Env: `SIDECAR_SUSPEND_MS`
  (default 5_000), `SIDECAR_STOP_MS` (default 300_000).
  Locks: `apps/sidecar/test/idleSuspend.test.mjs`,
  `apps/sidecar/test/serverIdleStop.test.mjs`,
  `apps/sidecar/test/serverCheckpointWiring.test.mjs`.
- **M20.2 (open).** Shared `BLOB_STORE` binding on web tier *and*
  sidecar. Sidecar persists source + latex compilation artefacts
  (but NOT supertex outputs) to blob store on every settle.
  Rehydrate on cold boot. Unblocks
  `verifyLiveGt6LiveEditableStateStopped`.
- **M20.3 (open).** Gold spec exercising the full cycle: open
  project, idle 6 s (suspended), edit → 300 ms ack; idle 6 min
  (stopped), edit → cold-start budget; content preserved.
  Override the 6 min stop timer for test purposes
  (`SIDECAR_STOP_MS` env).

Tuning note: 5 s suspend is aggressive but suspend cost is
~300 ms reconnect. Adjust via env vars if live use shows thrash.

### M21.target-page — max-visible-page wire signal

- **M21.1 max-visible logic + wire switch** (iter 296).
  `pickMaxVisible(items)` + `PageTracker.update()` widened to
  `{ mostVisible, maxVisible }`; `PdfViewer.svelte` IO callback
  sends `maxVisible` via `client.setViewingPage`. Sidecar
  `maxViewingPage(p)` reducer unchanged. Lock:
  `apps/web/test/pageTracker.test.mjs`.
- **M21.2 (open).** Gold spec: 3-page PDF, scroll so page 2
  fully visible and page 3's top intrudes → sidecar receives
  target=3. Needs a real 3-page Playwright source plus a sidecar
  introspection hook.
- **M21.3 (open).** Page-prefetch emit-decision investigation
  (queued iter 310). Critical context: `server.ts:528` hard-codes
  `targetPage: 0` → `recompile,end`. No active target-page gate;
  `maxViewingPage` only feeds `coalescer.kickForView`. M21.3a
  tightens `pickMaxVisible` to require ratio > some threshold
  (today: ratio > 0). M21.3b extends the iter-282 `daemon-stdin`
  debug log with `maxShipout` and `errorReason` from
  `collectRound`. M21.3c files upstream supertex repro if
  evidence points there.

### M22.debug-toasts — front→back wire coverage

From `293_answer.md` (7,8) + `306_answer.md`.

- **M22.1** (iter 304). `WsDebugEvent` extended with
  `outgoing-viewing-page`, `outgoing-create-file`,
  `outgoing-upload-file`, `outgoing-delete-file`,
  `outgoing-rename-file`. `recompile-request` is not on the list
  — the web client never sends one (recompile is server-driven
  from a `doc-update`). Lock:
  `apps/web/test/wsClientDebugEvents.test.mjs` case 9 + matrix in
  case 7.
- **M22.2 (open).** Finish GT-F local Playwright cases.
- **M22.3** (iter 305). Newest-on-top stack;
  user-dismissible × on info/success (error stays auto-only).
  Locks: `apps/web/test/toastStore.test.mjs` cases 2, 5.
- **M22.4a** (iter 309). `settingsStore.debugMode: boolean`
  default true; `FADE_MS_DEFAULT` 180 → 1000. `initDebugMode`
  resolves URL `?debug=1/0` > legacy `localStorage["debug"]`
  migration > settings (legacy key removed on first read). All
  `debug-*` TTLs 2/4 s → 10 s. `Toasts.svelte` keyed each gains
  `animate:flip` (500 ms cubicOut). New
  `apps/web/src/lib/compileCycleTracker.ts`: `running` resets
  timer, `idle`/`error` prefix toast text with elapsed seconds.
  Locks: `apps/web/test/settingsStore.test.mjs`,
  `apps/web/test/toastStore.test.mjs`,
  `apps/web/test/compileCycleTracker.test.mjs`,
  `apps/web/test/debugToastsToggle.test.mjs`.
- **M22.4b (open, wire change).** From `306_answer.md` items 7, 8.
  - `packages/protocol/src/index.ts`: `PdfSegment.shipoutPage?:
    number`; binary header 13 → 17 bytes, new `uint32` after
    `bytesLength`. 0 sentinel = unknown.
  - `apps/sidecar/src/compiler/supertexDaemon.ts:177` stamps the
    assembled segment with `shipoutPage: events.maxShipout`.
  - `apps/sidecar/src/server.ts:544` passes segment through
    unchanged.
  - `WsDebugEvent.pdf-segment` carries `shipoutPage`;
    `debugEventToToast` formats `[${n}.out] ${bytes} bytes` when
    known, falls back to `${bytes} bytes` when 0/missing.
  - Tracker also prefixes segment toast with `${elapsedMs}s — `.
  - Locks: `packages/protocol/test/codec.test.mjs` (header-width
    case), `apps/sidecar/test/supertexDaemon.test.mjs` if it
    asserts segment shape, `apps/web/test/debugToasts.test.mjs`,
    `apps/web/test/wsClientDebugEvents.test.mjs`.
- **M22.5** uniform 10 s TTL (iter 310). Supersedes M22.3's
  per-category split. `DEFAULT_TTL_MS.info/success/error` all
  10_000.

### M23.workspace-mirror — write every project file to disk

Queued iter 310 from `309_answer.md` item 2.
`apps/sidecar/src/workspace.ts` exposes only `writeMain(source)`;
auxiliary files added via `addFile` / `upload-file` live in Yjs +
blob storage but never reach the on-disk workspace dir the
supertex daemon spawns in (`cwd: workDir`). lualatex kpathsea
includes cwd; with `sec1.tex` absent from disk `\input{sec1}`
fails, no `[N.out]` events, `maxShipout` stays -1, server
returns `{ ok: true, segments: [] }`. Categorical regression for
any multi-file project.

Slices:

- **M23.1** Extend `ProjectWorkspace` with `writeFile(name,
  content)`, `deleteFile(name)`, `renameFile(oldName, newName)`.
  Atomic write-to-tmp-then-rename pattern (matches `writeMain`).
  Slashed paths need parent `mkdir -p` plus empty-parent reap on
  delete (mirror `LocalFsBlobStore.delete`).
  `validateProjectFileName` for sanitisation.
- **M23.2** Wire `apps/sidecar/src/persistence.ts` to call through
  on every Yjs-acked file mutation (`addFile` / `deleteFile` /
  `renameFile`). Subscribe to each non-main `Y.Text.observe` to
  mirror text edits to disk; debounce via the same coalescer that
  gates `writeMain`.
- **M23.3** Cold-boot rehydration. On project open, after
  persistence rehydrates from the blob store, mirror every
  non-main file to disk *before* the first compile call.
- **M23.4** Gold spec: 2-file project (`main.tex` with
  `\input{sec1}` + `sec1.tex` body); assert a `pdf-segment` ships
  and the rendered page contains the body. Local Playwright if
  feasible; otherwise a sidecar-level integration test.

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
- **Pin:** Playwright visual-snapshot diff on `/` and `/projects`,
  plus tight topbar-element snapshot on editor. Requires same
  snapshot primitive as M18.3.

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
M10.branding; M11.1/1b/1c/2a/5a; M12; M13.1; M13.2(a);
M13.2(b).1–3, .5 R2; M14; M15 sidecar fix + Step D plumbing;
M17; M17.b; M18.1; M19; M20.1; M21.1; M22.1/3/4a/5;
iter-200 coalescer extraction; iter-258/259 boot-time session
sweep; iter-280 layout math extraction + iter-290 dead-branch
removal; iter-293 startup `pw-*` sweep + machine-count threshold
bump.

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
