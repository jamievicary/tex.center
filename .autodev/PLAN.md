# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. M7.0.2 shared-sidecar pool
(`tex-center-sidecar` app with `app`-tagged deployment machines)
exists alongside but isn't routed to.

**Active priority queue (post iter 294, re-ordered per
`293_answer.md`):**

1. **M15 Step D awaiting first live run.** `seedMainDoc?: string`
   impl + `verifyLivePdfMultiPageSeeded.spec.ts` landed iter 292.
   Plumbing: `createProject` → `projects.seed_doc` (0003
   migration) → upstream resolver bakes base64-encoded seed into
   per-project Machine env (`SEED_MAIN_DOC_B64`) on first
   `createMachine` → sidecar decodes on boot, passes through to
   `createProjectPersistence({ seedMainDoc })` → first hydration
   uses override bytes in place of `MAIN_DOC_HELLO_WORLD`. Locks:
   `migrations.test.mjs`, `schema.test.mjs`, `projects-pglite.\
   test.mjs`, `apps/sidecar/test/persistenceSeed.test.mjs`,
   `apps/web/test/upstreamResolver.test.mjs`. Awaits a live gold
   run; outcomes branch (α)/(β) below.
2. **M18 PDF preview quality. PARTIAL (iter 295).** DPR-aware
   canvas sizing landed: new `pdfRenderScale(baseScale, dpr)` helper,
   `PdfViewer.svelte` renders at `1.5 × devicePixelRatio` backing
   pixels and hands CSS-px dimensions to the fade controller. Lock:
   `apps/web/test/pdfRenderScale.test.mjs`. Open follow-ups:
   ResizeObserver-driven re-render on `.preview` width change
   (coalesced trailing 100ms), and a gold visual-snapshot pin under
   forced DPR=2 (Playwright `--device-scale-factor=2`).
3. **M19 settings dialog + email-in-topbar.** Cog popover w/
   fade-duration slider; swap displayName→email. New.
4. **M21 max-visible page tracking.** New.
5. **M17 reopen — cross-fade blend math.** Switch to single-
   layer opacity (leaving canvas above, opacity 1→0; entering
   canvas below, opacity 1). Pin via center-pixel-flatness
   check.
6. **M22 wire-message debug toasts.** Front→back coverage for
   `outgoing-*` events; close M9.editor-ux GT-F.
7. **M20 lifecycle (suspend/stop/cold-storage).** Absorbs the
   former priority #2 M13.2(b).5 R1: shared `BLOB_STORE` widens
   from "seed main.tex" to "full project tree" so cold-stopped
   resume restores `.aux`/checkpoint as well as source.
8. **M11.5a text drop-upload.** Drop `.tex` files onto file tree
   → `upload-file` (text path, already exists). Binary stays
   blocked.
9. **M16.aesthetic.** Type pair + 4-colour palette retune for
   chrome surfaces; visual-snapshot diffs on `/` and `/projects`
   plus a topbar snapshot on the editor route.
10. **M11.2.** Create/delete/rename via context menu + keyboard
    (`F2`, `Del`-with-confirm), reusing extant sidecar verbs.

**Open red specs (post iter 290):**

- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — RED,
  expected, blocked on M13.2(b).5 R1.
- (none, post iter 293). `test_machine_count_under_threshold`
  threshold bumped 5 → 10 (the human user's manual `Test`/`Test11`
  projects occupy ~5 legitimate Machines; original threshold was
  set before live-deploy human usage). Iter-293 stale-`pw-*`
  startup sweep prevents Playwright leftovers from accumulating.

**Watch-list (may be flaky, may be regression):**

- `verifyLivePdfMultiPage` static (60s `.cm-content` wait) and
  `verifyLiveGt8ColdProjectNewpageDaemonCrash` (30s `.cm-content`
  wait) both timed out iter 289 then GREEN iter 290. Treat as
  known-flake under live cold-start race for now; revisit if
  either flips RED twice in a row.
- `verifyLiveGt6LiveEditableState` (M13.2(b).3) was GREEN
  iter 256–279, RED iter 280 once, GREEN since. Watch for
  recurrence around the suspended-resume boundary.

## 2. Milestones

### M9.editor-ux — live editor UX bugs

Closed slices (live locks all retained, see git log + `.autodev/
logs/` for narrative): clickable logo; no-flash editor load;
compile coalescer (`apps/sidecar/src/compileCoalescer.ts`);
sustained-typing safety; toast store + component scaffold; toast
consumers for `file-op-error` and compile errors; debug-mode
toggle (URL / localStorage / Ctrl+Shift+D) with protocol fan-out
via `WsDebugEvent`. Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Other closed regressions, all with live locks retained: gt6 slow
`.cm-content` (M13.2(a) SSR seed gate); gt7 daemon crash under
rapid typing (upstream `2fb543e`); M7.4.x GT-5 (upstream
`8c3dec0`); M9.live-hygiene.leaked-machines (per-project Machine
tagging + orphan-tag sweep); M9.live-hygiene.delete-project.

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
  Local + live Playwright variants. Blocked on a sidecar
  persistence-ack wire signal that doesn't exist yet.

### M11.file-tree — tree component + CRUD UX (post-MVP)

**Constraint (iter 262):** native-Svelte-5-no-third-party-tree-lib
rule dropped. Using `@headless-tree/core` directly; Svelte 5
binding written in-tree (no `@headless-tree/svelte` on npm).

Closed sub-slices, all locks retained:

- **M11.1** rendering substrate. `apps/web/src/lib/fileTree.ts`
  + per-row markup. Lock: `apps/web/test/fileTree.test.mjs`.
- **M11.1b** slashed paths. `validateProjectFileName` permits
  `/`-separated multi-segment paths; `LocalFsBlobStore.delete`
  reaps empty parent directories up to root. Locks:
  `packages/blobs/test/localFs.test.mjs`,
  `apps/sidecar/test/slashedFileNames.test.mjs`,
  `packages/protocol/test/codec.test.mjs`.
- **M11.1c-prep** headless adapter scaffolding:
  `apps/web/src/lib/fileTreeHeadless.ts` (`buildFileItemMap` +
  `createFileTreeInstance`). Lock:
  `apps/web/test/fileTreeHeadless.test.mjs`.
- **M11.1c** headless-tree cutover. `FileTree.svelte` rewritten
  to drive flat render from `createFileTreeInstance(forest)\
  .getItems()`. `collapsed: Set<string>` tracks user-collapsed
  folders, default all-expanded. Lock:
  `tests_gold/playwright/editor.spec.ts` local case asserts
  `.tree [role=treeitem] .label` matches `main.tex`.

Remaining sub-slices:

- **M11.2** create/delete/rename via context menu + keyboard
  (`F2`, `Del`-with-confirm).
- **M11.3** create folder via virtual-folder model. UI affordance
  needs design (probably a placeholder entry the user can name).
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5a** OS drop-upload — text files. Drop `.tex`/`.bib`/
  any UTF-8 source onto the file tree → existing `upload-file`
  text path. Unblocked; small. From `293_answer.md` (9).
- **M11.5b** OS drop-upload — binary assets (images, fonts,
  PDFs). Blocked by FUTURE_IDEAS "binary asset upload" wire
  design.
- **M11.5c** drag-out download from tree to OS. Unblocked.

### M12.panels — draggable dividers

**Closed iter 257.** Inline in editor `+page.svelte` with
`--col-tree` / `--col-preview` CSS custom properties; editor pane
`1fr`. Min widths 150/200/200. Per-project widths in
`localStorage["editor-widths:${projectId}"]`. Layout math extracted
iter 280 to `apps/web/src/lib/editorPanelLayout.ts` (dead
`preview > maxPreview` branch deleted iter 290; invariant
pinned). Locks: `apps/web/test/editorPanelLayout.test.mjs`,
`tests_gold/playwright/editorPanelDividers.spec.ts`.

### M13.open-latency — instrument-then-fix

- **M13.1 instrumentation.** Closed iter 236.
  `apps/web/src/lib/editorMarks.ts`. Conclusion: route→ws-open
  ~11.5s dominates (cold per-project Machine).
- **M13.2(a) SSR seed gate.** Closed iter 238 (GT-6 GREEN iter
  240). `+page.server.ts` returns a `seed` when no
  `machine_assignments` row exists; editor renders
  `<pre class="editor-seed">` inside `.editor` until
  `snapshot.hydrated`. Load-bearing: seed is visual-only, never
  inserted into the local Y.Doc (CRDT can't dedupe two
  independent `insert(0, …)` ops with different `clientID`);
  placeholder is `<pre>`, not `.cm-content`, so existing live
  specs typing into `.cm-content` still wait for the real
  CodeMirror mount.
- **M13.2(b) fully-live within 1000 ms on cold access. PARTIAL.**
  - **(b).1** no-auto-destroy + self-suspend. Closed iter
    249/250 (resume-bug fix iter 255). `auto_destroy:false`;
    sidecar idle handler calls `POST /machines/{self}/suspend`.
    On `null` `suspendSelf` or fetch-throws, fallback path
    closes app + `exit(0)`. Tests:
    `apps/sidecar/test/idleSuspend.test.mjs`.
  - **(b).2** optimistic project delete. Closed iter 254.
    `deleteProject` deletes DB row first, then fire-and-forget
    `destroyMachine`. Tests:
    `apps/web/test/deleteProject.test.mjs`.
  - **(b).3** suspended-resume gold case. GREEN by iter 260
    (cmContentReadyMs=857, keystrokeAckMs=17). Resumes in
    ~300ms; no seed widening needed.
    `verifyLiveGt6LiveEditableState.spec.ts`.
  - **(b).4** stopped-state cold-editable pin. RED, expected.
    `verifyLiveGt6LiveEditableStateStopped.spec.ts`. Drives
    `POST /machines/{id}/stop`, polls `state==="stopped"`,
    measures `cmContentReadyMs` / `keystrokeAckMs` vs 1000ms.
    Concrete target for (b).5.
  - **(b).5 fix. PARTIAL.**
    - **R1. OPEN.** Widen SSR seed for non-fresh projects:
      fetch persisted source from shared blob store so
      `.cm-content` shows real content during Machine cold-
      start. Prerequisite for (b).4 GREEN. Requires shared
      `BLOB_STORE` binding (web side currently has none).
    - **R2. LANDED iter 267.** `createIdleHandler` no longer
      exits on `suspendSelf` failure; throw path logs and
      re-arms instead of `app.close()` + `exit(0)`. Local-dev
      path (`suspendSelf === null`) keeps close-and-exit.

  **Known follow-ups for M13.2:**
  - `cleanupProjectMachine` re-arms the SSR seed gate even
    though sidecar blob store may still hold the user's edits.
    Benign while blob store is per-Machine; once shared, the
    gate must flip from "no machine assignment" to "no
    persisted blob".
  - GT-A passes because it polls `.cm-content` (only appears
    post-hydrate); the seed placeholder is a separate DOM
    element. If a future iteration consolidates seed and real
    editor under one `.cm-content`, GT-A's invariant must
    survive.

### M14.title-bar — centred project title in editor topbar

**Closed iter 264.** `data.project.name` rendered as
`<h1 class="project-title" data-testid="project-title">`. Topbar
grid `1fr auto 1fr`. Lock: editor.spec.ts asserts
|title-centre-x − topbar-centre-x| ≤ 2px.

### M15.multipage-preview — page-1-only PDF bug

Promoted from `241_*`. Sidecar `targetPage=0` fix closed iter
269 (`tests_gold/cases/test_supertex_multipage_emit.py` GREEN).

**Live status (post iter 290).** Both `verifyLivePdfMultiPage`
cases — static atomic-replace and in-body manual edit — are
GREEN. The static case has been GREEN since iter 288 (its first
live run, surprise outcome). The in-body case was added iter
289 as the user-shaped pin (cursor on `.cm-line` index 2 →
End → Enter → `\newpage` → Enter → "Page two body text.");
GREEN on first live run (iter 289, "second surprise") and
again iter 290.

**This means: no Playwright editing flow reproduces the bug
the user reports.** The two pins together rule out (i) the
atomic-replace path, (ii) the in-body cursor-positioned typing
path, and (iii) the iter-284 (β) cursor-past-`\end{document}`
hypothesis at source level (shape-sanity assert verifies typed
bytes land between "Hello, world!" and `\end{document}`).

**Step D landed iter 292.** `seedMainDoc?: string` impl
end-to-end:
- `packages/db/src/migrations/0003_add_projects_seed_doc.sql`
  adds `projects.seed_doc text NULL`; drizzle + schema updated.
- `createProject({ ..., seedMainDoc })` persists to the column;
  `getProjectSeedDoc(db, id)` reads it back.
- `apps/web/src/lib/server/upstreamResolver.ts` accepts a
  `seedDocFor: (id) => Promise<string|null>` option; when
  non-null, the new Machine is created with `env.SEED_MAIN_DOC_\
  B64=<base64>`. Wired through `upstreamFromEnv.ts` + the
  production entry `apps/web/src/server.ts`.
- `apps/sidecar/src/server.ts` decodes `SEED_MAIN_DOC_B64` on
  boot and passes through to `createProjectPersistence({
  seedMainDoc })`. `persistence.ts` uses the override in place
  of `MAIN_DOC_HELLO_WORLD` only when no `main.tex` blob exists
  yet (first-hydration default; never clobbers persisted
  content).
- Gold spec `tests_gold/playwright/verifyLivePdfMultiPageSeeded.\
  spec.ts` creates a project with `seedMainDoc: STATIC_TWO_PAGE`,
  opens it, and asserts ≥2 pages render with zero keyboard
  input. Awaits live run.

Two informative outcomes:
- **(α) seeded case green-passes.** Decisive: bug is in some
  path neither the editing pins nor the seeded path exercises.
  Most likely candidate: the user's actual main.tex content
  contains something (LaTeX package, math env, figure) the
  shipped 2-page test sources don't. Next action is to ask
  the user for the offending source via discussion mode.
- **(β) seeded case red-fails.** Decisive: bug is reproducible
  with zero editing. Then deploy iter-286's
  `compile-source` / `daemon-stdin` / `daemon-stderr` debug log
  (`apps/sidecar/src/server.ts` — env `DEBUG_COMPILE_LOG`,
  ON by default) and `flyctl logs -a tex-center-sidecar
  --no-tail` (NOT `-f`, per iter-150 hygiene) to classify per
  Step C' (i)/(ii)/(iii) below.

Step C' (deploy + diagnose against the existing iter-289
in-body pin) is moot now that the in-body pin is GREEN.
Retained as fallback diagnostic procedure for (β):
  - **(i)** One post-edit pdf-segment frame, small payload →
    supertex emitted only page 1 OR sidecar broadcast dropped
    page 2. Cross-check against
    `test_supertex_incremental_multipage_emit.py`.
  - **(ii)** Multiple pdf-segment frames OR one large frame →
    wire carried >1 page. Viewer-side bug — `PdfViewer.svelte`
    / `pdfFadeController.ts`.
  - **(iii)** `compile-status` `error` → daemon failed on the
    edited source. Read `lastErrorDetail`; if real upstream
    failure, file `vendor/supertex/discussion/<N>_question.md`
    *committed to the submodule*.

Local pin `test_supertex_incremental_multipage_emit.py`
retained as regression / shape-baseline.

### M18.preview-quality — DPR-aware PDF rendering

From `293_answer.md` (1).

**M18.1 DPR-aware backing store. Closed iter 295.**
`apps/web/src/lib/pdfRenderScale.ts` exposes
`pdfRenderScale(baseScale, dpr) → {cssScale, pixelScale}`;
`PdfViewer.svelte` reads `window.devicePixelRatio` once per commit,
renders the canvas at `pixelScale` (so backing-store ≥ display
resolution on HiDPI), and hands `cssScale`-sized dimensions to the
fade controller for layout. Non-finite / non-positive DPR falls back
to 1. Lock: `apps/web/test/pdfRenderScale.test.mjs`.

**M18.2 (open).** ResizeObserver on `.preview` re-renders on width
change (coalesced trailing 100ms) so the backing store also tracks
divider drags. Today the wrapper has `max-width:100%` and the canvas
`width:100%`, so a shrunk pane still looks fine (down-scaling); a
widened pane up-scales until the next commit. Low priority — wait
for user feedback before sinking the iteration cost.

**M18.3 (open).** Gold visual-snapshot pin under
`devices.use({ deviceScaleFactor: 2 })`. Confirms the DPR multiplier
actually reaches the canvas. Defer until the playwright snapshot
infra grows a stable comparison primitive (M16.aesthetic also needs
this).

### M19.settings — settings dialog + email in topbar

From `293_answer.md` (2,3). Cog button in editor topbar, left of
email/sign-out. Popover (not modal). Slider: fade-duration
0–3s step 0.05s, default 0.18s. Persist via
`localStorage["editor-settings"]` (JSON object — single key for
all future settings). Apply live via `--pdf-fade-ms` CSS var
+ `FADE_MS` const removed.

Slices:
- **M19.1** `apps/web/src/lib/settingsStore.ts` (Svelte 5
  runes) + topbar cog affordance.
- **M19.2** fade-duration slider; wire to PdfViewer +
  controller. Email-in-topbar (swap `displayName ??
  email` → `email`). Update affected tests.
- **M19.3** keyboard / a11y (Esc closes; focus management).

### M20.lifecycle — suspend → stop → cold-storage cascade

From `293_answer.md` (4). Two-tier idle cascade with full
cold-storage. Absorbs M13.2(b).5 R1.

Slices:
- **M20.1** two-stage idle timer in sidecar (env-configurable
  `SIDECAR_SUSPEND_MS` default 5_000, `SIDECAR_STOP_MS` default
  300_000). Tests assert both timers fire at the right
  boundary.
- **M20.2 (formerly M13.2(b).5 R1).** Shared `BLOB_STORE`
  binding on the web tier *and* sidecar; sidecar persists
  source + `.aux` + `.log` + supertex checkpoint blob to it on
  every settle, and rehydrates from it on cold boot. Unblocks
  `verifyLiveGt6LiveEditableStateStopped`.
- **M20.3** gold spec exercising the full cycle: open project,
  idle 6 s (suspended), edit → 300 ms ack; idle 6 min
  (stopped), edit → cold-start budget; content preserved
  across both.

Tuning note: 5 s suspend is aggressive but suspend cost is
~300 ms reconnect. Adjust via env vars if live use shows
thrash.

### M21.target-page — max-visible-page wire signal

From `293_answer.md` (6). Today `pageTracker` returns the
*most-visible* page. GOAL item 4 needs *max-visible* so the
sidecar can compile every page the user can see.

Plan:
- Add `PageTracker.maxVisiblePage()` (and a callback) alongside
  the existing most-visible behaviour.
- Wire the editor page to send `max` over the existing
  `viewing-page` message (semantic widened; name retained).
- Gold spec: 3-page PDF, scroll so page 2 fully visible and
  page 3's top edge intrudes → sidecar receives target=3.

### M22.debug-toasts.b — front→back wire coverage

From `293_answer.md` (7,8). Closes M9.editor-ux GT-F.

Slices:
- **M22.1** emit `outgoing-*` debug events in `wsClient.ts` for
  every send (`viewing-page`, `recompile-request`,
  `create-file`, `delete-file`, `rename-file`, `upload-file`),
  map to toasts via `debugToasts.ts`. Per-event aggregateKey.
  Gated on `?debug=1` only.
- **M22.2** finish GT-F local Playwright cases.
- **M22.3** toast UX polish: info TTL 4s→5s; stack order
  newest-on-top; user-dismissible × on info/success.

### M17.b reopen — cross-fade blend math

From `293_answer.md` (5). Current stacked-opacities path
exhibits a mid-fade background-bleed dip
(`T·NEW + (1−T)²·OLD` instead of `T·NEW + (1−T)·OLD`).

Fix A: single opacity layer — leaving canvas on top, opacity
`1→0`; entering canvas underneath, opacity 1.

Pin: extend `verifyLivePdfNoFlashBetweenSegments` (or new
`verifyLivePdfCrossfadeFlatness`) to sample the centre pixel of
a flat-grey region at T≈0.5 and assert |RGB − target| ≤ 1.

### M16.aesthetic — writerly chrome retune

Retune site CSS for chrome surfaces (landing, dashboard, editor
topbar/tree/status). Editor and PDF preview content surfaces
stay strictly functional.

- **Type pair:** Source Serif 4 (body / project names / hero
  prose; OFL, variable) + Inter (UI affordances; OFL, variable).
  Self-host both. Monospace in CodeMirror pane unchanged.
- **Palette (4 colours):** Paper `#FAF7F0` + Ink `#1F1B16` +
  Quill `#2E4C6D` (accent / links / primary buttons) + Margin
  `#D9CFBF` (rules, dividers, chevron tints). Editor pane
  background and PDF canvas stay neutral.
- **Pin:** Playwright visual-snapshot diff on `/` and
  `/projects`, plus a tight topbar-element snapshot on the
  editor route.

### M17.preview-render — PDF preview cross-fade

**Closed iter 271 (impl) + iter 273 (pin).**
`apps/web/src/lib/pdfFadeController.ts` owns the per-page fade
state machine (mid-fade interrupt → snapshot, cross-fade,
add/remove wrapper transitions). `PdfViewer.svelte` renders all
pages off-DOM then hands the controller per-page canvas
descriptors; wrappers carry `data-page` so the
IntersectionObserver target is stable across renders. Tests:
`apps/web/test/pdfFadeController.test.mjs` +
`verifyLivePdfNoFlashBetweenSegments`.

### M8.pw.3.3 — real-OAuth-callback live activation

Code complete. Operator-gated: create test OAuth client in GCP
(redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push `TEST_OAUTH_BYPASS_KEY`
to Fly secrets. Then `verifyLiveOauthCallback.spec.ts` un-skips.

### M7.5 — daemon-adoption hardening

Rate limits, observability surface, narrower deploy tokens.
**Deferred**, post-MVP.

### Completed

M0–M7.5.5; M8.smoke.0; M8.pw.0–M8.pw.4-reused; M9.observability
(iter 163); M9.cold-start-retry (iter 164 + 168 TCP-probe);
M9.resource-hygiene (iter 175/176); M9.gold-restructure (iter 197);
M10.branding (iter 194); iter-200 coalescer extraction; M13.1
(iter 236); M13.2(a) (iter 238); M13.2(b).1 (iter 249/250);
M13.2(b).2 (iter 254); M13.2(b).3 spec (iter 256); boot-time
session sweep (iter 258/259); M14.title-bar (iter 264);
M13.2(b).4 pin (iter 266); M13.2(b).5 R2 (iter 267); M15 sidecar
fix (iter 269); M17 (iter 271/273); M12 layout extraction (iter
280); M11.1c headless-tree cutover (iter 284); M15 Step A
sidecar debug log (iter 286); M15 Step B static-source spec
(iter 288); M15 Step B' in-body-edit spec (iter 289);
clampPanelWidths dead-branch removal (iter 290); stale-`pw-*`
project startup sweep + machine-count threshold bump (iter 293);
M18.1 DPR-aware PDF backing store (iter 295).
See git log and `.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- ~~`test_machine_count_under_threshold` RED iter 290.~~ Closed
  iter 293. The PLAN diagnosis ("Machines created without the
  sweepable tag, or sweep's tag match too narrow") was wrong:
  every per-project Machine carried `texcenter_project=<uuid>`
  and the sweep recognised it. The real cause was that the
  human user had created ~5 manual `Test`/`Test11`-named
  projects via the live dashboard, each owning a legitimate
  per-project Machine, and the threshold of 5 didn't
  accommodate that growth. Fix: `DEFAULT_MAX` bumped 5 → 10
  AND new `cleanupOldPlaywrightProjects` startup sweep
  (`tests_gold/lib/src/`) reaps `pw-*`-named projects older
  than 10 min from DB + their Fly Machines.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. The
  iter-251 parse-smoke sketch landed iter 252 as
  `tests_normal/cases/parse_playwright_fixtures.mjs` (AST
  walker for block-scoped redeclaration).

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:
true` paired with an explicit kill before iteration end. Never
pipe such a command into a downstream that waits for EOF
(`… | tail -N`, `… | head`) — that pipeline shape wedged
iter 148.
