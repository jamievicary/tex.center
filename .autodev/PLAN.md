# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. M7.0.2 shared-sidecar pool
(`tex-center-sidecar` app with `app`-tagged deployment machines)
exists alongside but isn't routed to.

**Active priority queue (post iter 290):**

1. **M15 second-surprise branch.** Both M15 live pins (static
   atomic-replace + in-body manual edit) GREEN iter 289 and again
   iter 290. The user's bug report ("preview NEVER >1 page even
   on manually-typed multi-page docs", `284_answer.md` addendum)
   is not reproducible by any Playwright editing flow we've
   written. Next step per PLAN M15: pull `seedMainDoc?: string`
   impl from `287_answer.md` option (1) — protocol +
   `projects.seed_doc` migration + sidecar first-hydration read —
   and add a literal "no editing at all" gold case (open a
   project whose seeded `main.tex` is the 5-line static
   two-page LaTeX, assert ≥2 pages render with zero keyboard
   input). ~30 LoC impl + new spec. If green, we have decisive
   evidence the bug is in some path neither Playwright nor any
   shipped pin exercises, and the next move is to ask the user
   for a screen recording or source dump.
2. **M13.2(b).5 R1.** Widen SSR seed for non-fresh projects via
   shared blob store. Unblocks `verifyLiveGt6LiveEditableState\
   Stopped` (the only legitimately RED live spec). Requires
   shared `BLOB_STORE` binding on the web tier.
3. **M16.aesthetic.** Type pair + 4-colour palette retune for
   chrome surfaces; visual-snapshot diffs on `/` and `/projects`
   plus a topbar snapshot on the editor route.
4. **M11.2.** Create/delete/rename via context menu + keyboard
   (`F2`, `Del`-with-confirm), reusing extant sidecar verbs.

**Open red specs (post iter 290):**

- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — RED,
  expected, blocked on M13.2(b).5 R1.
- `test_machine_count_under_threshold` — RED iter 290 (6/8
  non-shared sidecar Machines, threshold 5). Live-spec teardown
  appears to have leaked per-project Machines from prior runs;
  the orphan-tag sweep only catches Machines tagged with the
  test-owner sentinel. Triage: investigate which spec creates
  Machines without the sweepable tag, or widen the sweep's tag
  match. Probably benign infra hygiene but blocks `tests_gold`
  exit-zero until cleared.

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
- **M11.5** OS drop-upload + drag-out download. Drop-upload
  blocked by FUTURE_IDEAS "binary asset upload"; drag-out
  download unblocked.

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

**Next step (Step D).** Implement `seedMainDoc?: string` per
`287_answer.md` option (1): add field to `createProject`,
`projects.seed_doc TEXT` drizzle migration, sidecar
first-hydration reads it from the web tier or via Machine env
var. ~30 LoC + new gold spec `verifyLivePdfMultiPageSeeded.\
spec.ts`: create a project whose seed is the 5-line
STATIC_TWO_PAGE, open it, assert ≥2 pages render with zero
keyboard input. Two outcomes:
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
clampPanelWidths dead-branch removal (iter 290). See git log
and `.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **`test_machine_count_under_threshold` RED iter 290.** Six
  non-shared sidecar Machines vs threshold 5. Some live-spec
  teardown is leaking per-project Machines without the orphan-
  sweep tag. Triage path: log spec exits to find which spec
  creates without `texcenter_test_owner=...` (or equivalent),
  or widen the sweep's tag match. Likely benign hygiene but
  currently blocks gold exit-zero.
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
