# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. M7.0.2 shared-sidecar pool
(`tex-center-sidecar` app with `app`-tagged deployment machines)
exists alongside but isn't routed to. Iteration indicator wired
through Dockerfile build-arg into the topbar (regression-locked).

All eight live gold cases (GT-A/B/C/D/5/6/7/8) GREEN as of iter
240; delete-project pin (`verifyLiveDeleteProject`) GREEN iter 251.

**Current live focus: M13.2(b) — fully-live editor within 1000 ms
on cold project access.** M13.2(b).1 (no-auto-destroy + self-suspend)
landed iter 249, deployed iter 250. M13.2(b).2 (optimistic delete)
landed iter 254. M13.2(b).3 (new gold spec on cold cm-content +
first op) open.

Full diagnoses: GT-5 in `.autodev/logs/202.md`; M7.4.x closing in
`.autodev/discussion/230_answer.md`; M13 timeline in
`.autodev/logs/236.md`; M13.2(b) cold-Machine audit in
`.autodev/discussion/246_answer.md`.

## 2. Milestones

### M9.editor-ux — live editor UX bugs

Done and locked: clickable logo, no-flash editor load, compile
coalescer (extracted iter 200), sustained-typing safety, toast
store + component scaffold, toast consumers for `file-op-error`
and compile errors, debug-mode toggle
(URL/localStorage/Ctrl+Shift+D) with protocol fan-out via
`WsDebugEvent`. Sidecar `assembleSegment` directory-scan fallback
removed. Gold restructure (iter 197 + 210): warm-up + project
creation in `globalSetup.ts`
(`fixtures/liveProjectBootstrap.ts`), test-scoped fixture reads
env, per-test `timeout` = 45s.

Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Closed regression slices (live + local locks retained):

- **gt6 slow `.cm-content` appearance.** Closed iter 240 by
  M13.2(a) SSR seed gate. Lock: `verifyLiveGt6FastContentAppearance`.
- **gt7 daemon crash under rapid typing.** Closed iter 227,
  upstream fix in `vendor/supertex` `2fb543e`. Locks: GT-7/8 live
  + four local supertex tests. Narrative:
  `.autodev/discussion/225_answer.md`, `226_*`.
- **M7.4.x — GT-5.** Closed iter 231, upstream fix `8c3dec0`.
  Locks: GT-5 live + `supertexWarmDocBodyEditNoop.test.mjs`.
- **M9.live-hygiene.leaked-machines.** Landed iter 243 (per-project
  Machines tagged via `config.metadata.texcenter_project`, count
  guardrail filters shared-pool); orphan-tagged auto-sweep added
  iter 247 (`tests_gold/lib/src/sweepOrphanedSidecarMachines.ts`
  in `globalSetup` teardown). The 2 legacy untagged orphans
  destroyed iter 250.
- **M9.live-hygiene.delete-project.** Endpoint + UI landed iter 245
  (`apps/web/src/lib/server/deleteProject.ts`, `?/delete` form
  action), live spec pre-condition fixed iter 246 (poll on
  `machine_assignments` row not SSR text). Lock:
  `verifyLiveDeleteProject` (green iter 251). R2 blob reap deferred
  (requires shared `BLOB_STORE` binding).

Remaining slices:

- **GT-E (local Playwright).** info/success/error spawn the right
  toast; repeated `file-op-error` produces a `×N` aggregated badge.
- **GT-F (local Playwright).** `?debug=1` flips localStorage; a
  single keystroke produces a green Yjs-op toast and (after
  compile) a blue pdf-segment toast; rapid typing aggregates into
  one green `×N`; without the flag, no debug toasts.
- **Save-feedback affordance.** `SyncStatus` indicator
  (idle/in-flight/error) sourced from Yjs provider sync state
  acked by a sidecar persistence signal (NOT per-keystroke). The
  success toast lives here and depends on the same ack — gated on
  a sidecar persistence-ack wire signal that doesn't exist yet.
  Local + live Playwright variants.

### M11.file-tree — tree component + CRUD UX (post-MVP UX)

Native Svelte 5 component (no React island, no third-party tree
lib). Sub-slices, each its own iteration:

- **M11.1 rendering substrate. Landed iter 261.**
  `apps/web/src/lib/fileTree.ts` (`buildFileTree` pure
  path-grouping forest, folders-first/alphabetic sort) +
  `apps/web/src/lib/FileTreeNode.svelte` (self-recursive
  collapsible node) consumed by `FileTree.svelte`. Behavior on
  today's flat names is unchanged (server's
  `validateProjectFileName` still forbids `/`). Lock:
  `apps/web/test/fileTree.test.mjs`. Folder collapse state lives
  in `FileTree.svelte` as `Map<path, boolean>`; default expanded.
- **M11.1b** relax `validateProjectFileName` to permit
  `/`-separated segments, update sidecar persistence to
  `mkdir -p` parent dirs on write/rename and reap empty parents
  on delete. Folders become a live concept end-to-end. Required
  before M11.3 has any effect.
- **M11.2** create/delete/rename via context menu + keyboard
  (`F2`, `Del`-with-confirm). Reuses extant sidecar verbs.
- **M11.3** create folder via virtual-folder model (no sentinel
  file; folder materialises on first child). Gated on M11.1b.
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5** OS-drop upload. **Blocked by FUTURE_IDEAS "binary
  asset upload"** for non-UTF-8 payloads.

### M12.panels — draggable dividers (post-MVP UX)

Landed iter 257. Inline implementation in
`apps/web/src/routes/editor/[projectId]/+page.svelte`: pointer-
capture drag updates `--col-tree` / `--col-preview` CSS custom
properties; editor pane is `1fr`. Min widths 150/200/200
(tree/editor/preview). Per-project widths persisted to
`localStorage["editor-widths:${projectId}"]`. Local gold lock:
`tests_gold/playwright/editorPanelDividers.spec.ts` (two cases —
drag tree, drag preview; both assert reload-persistence). The
"file picker collapsible to zero with re-open chevron" was
explicitly deferred for scope; recorded as a FUTURE_IDEAS
candidate.

### M13.open-latency — instrument-then-fix

- **M13.1 instrumentation. Closed iter 236.** `performance.mark`
  helpers at `apps/web/src/lib/editorMarks.ts`. Diagnostic
  conclusion: route→ws-open ~11.5 s dominates entirely (cold
  per-project Machine). See `.autodev/logs/236.md`.
- **M13.2(a) SSR seed gate. Closed iter 238, GT-6 green iter 240.**
  `apps/web/src/routes/editor/[projectId]/+page.server.ts` returns
  a `seed` when no `machine_assignments` row exists; editor renders
  `<pre class="editor-seed">` inside `.editor` while
  `snapshot.hydrated` is false. Two load-bearing design calls:
  (1) seed is visual-only, never inserted into the local Y.Doc
  (CRDT can't dedupe two independent `insert(0, …)` ops with
  different `clientID`); (2) placeholder is `<pre>`, not
  `.cm-content`, so existing live specs typing into `.cm-content`
  still wait for the real CodeMirror mount. GT-6 polls `.editor`
  textContent.
- **M13.2(b) — fully-live within 1000 ms on cold access. OPEN.**
  GT-6 only asserts the SSR seed `<pre>`; the real bar is Yjs
  connected + CodeMirror bound + typing not dropped.

  1. **M13.2(b).1. Landed iter 249, deployed iter 250; resume-bug
     fix landed + deployed iter 255.** `auto_destroy: false` in
     `apps/web/src/lib/server/upstreamFromEnv.ts`. Sidecar idle
     handler in `apps/sidecar/src/index.ts` calls
     `POST /machines/{self}/suspend`; on resume it must NOT close
     the app and must NOT exit (the Fly response-then-freeze
     semantic means the suspend fetch resolves post-resume with the
     listener still bound — iter 249 got this wrong, iter 255 fixed
     it). On `null` `suspendSelf` (local dev) or fetch-throws,
     fallback path closes app + `exit(0)`. `server.ts` passes
     `{ rearm }` to `onIdle` so the post-resume path can re-arm the
     idle gate. Unit tests in `apps/sidecar/test/idleSuspend.test.mjs`.
  2. **M13.2(b).2 — optimistic project delete. Landed iter 254.**
     `deleteProject` now deletes the DB row first, then kicks off
     Fly `destroyMachine` as fire-and-forget. The result exposes a
     `destroyComplete: Promise<{destroyed, error?}>` for tests; the
     `/projects` `?/delete` action ignores it and redirects
     immediately. Non-404 destroy failures are logged via the
     injectable `logError` (default `console.error`) and never
     raised. Orphan-tag sweep in `globalSetup` teardown remains the
     safety net. Unit tests in `apps/web/test/deleteProject.test.mjs`
     including a gated-promise test asserting the helper returns
     before `destroyMachine` settles. Live gold
     (`verifyLiveDeleteProject`) unchanged; its 30 s wait for the
     row link to disappear remains in place — a tighter
     post-click latency assertion was considered but rejected as
     flake-prone over the live network (form POST → 303 → fresh
     GET /projects, p99 well above 500 ms on a cold path).
  3. **M13.2(b).3 — cold-editable gold case. Spec landed iter 256.**
     `tests_gold/playwright/verifyLiveGt6LiveEditableState.spec.ts`.
     Cold-starts a fresh project, leaves `/editor`, drives the
     per-project Machine into the `suspended` state via the Fly
     Machines API (`POST /machines/{id}/suspend` — same endpoint
     the sidecar's own idle handler calls; bypasses the 10-min idle
     timer to keep the test under a few minutes wallclock). Then
     clicks the dashboard link and asserts (a) `.cm-content`
     contains the seeded `documentclass` sentinel within 1000 ms
     of click, and (b) a single keystroke produces a Yjs
     `TAG_DOC_UPDATE` (0x00) `framesent` event within 1000 ms.
     Landed iter 256; observed GREEN by iter 260 gold run
     (cmContentReadyMs=857, keystrokeAckMs=17). The suspended-resume
     path is faster than expected: `.cm-content` populates within
     budget without the seed-widening follow-up, because the
     suspended Machine resumes in ~300 ms and the existing
     `.editor-placeholder`/SSR-seed path no longer dominates. The
     "widen SSR seed for non-fresh projects" follow-up below
     remains useful for the cold-stopped (non-suspended) case but
     is no longer load-bearing for M13.2(b).3. Keeps current GT-6
     (`verifyLiveGt6FastContentAppearance`) as the regression lock
     on M13.2(a).

  **Known follow-ups for M13.2:**

  - Non-fresh projects (those with a `machine_assignments` row)
    still show the blank `.editor-placeholder` for ~11.5 s on
    reconnect into a cold-stopped Machine. Widen the seed surface
    to fetch the current persisted source from R2/blob-store in
    `+page.server.ts` when a row exists. Requires the web side to
    read the same blob store the sidecar writes; currently
    `BLOB_STORE` lives only on each per-project Machine. Schedule
    alongside M11.5 binary-asset wire work (shared R2 bucket).
  - GT-A passes because it polls `.cm-content` which only appears
    post-hydrate; the seed placeholder is a separate DOM element.
    If a future iteration consolidates seed and real editor under
    one `.cm-content`, GT-A's invariant must be carried through.
  - `machine_assignments`-row deletion via `cleanupProjectMachine`
    re-arms the SSR seed gate even though the sidecar's blob store
    may still hold the user's edits. Benign while the blob store
    remains per-Machine; once shared, the gate must flip from
    "no machine assignment" to "no persisted blob".

Default sequencing: **M13.2(a) seed widening for non-fresh
projects (M13.2(b).3 closer)** or **M11.1 read-only collapsible
tree** next — M13.2(b).3 spec landed iter 256, M12 landed iter
257. M11.5 gated on binary-asset wire work.

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
M9.resource-hygiene (iter 175 spec teardown + count guardrail;
iter 176 idle-stop arm at startup); M9.gold-restructure (iter 197,
warm-up + fast per-spec timeouts); M10.branding (iter 194, logo
SVGs at `apps/web/src/lib/logos/{linear,stacked}.svg`, inlined via
Vite `?raw` import; brand wrapper is
`<span role="img" aria-label="tex.center">`, editor route uses
`<a class="brand">`); iter-200 coalescer extraction
(`apps/sidecar/src/compileCoalescer.ts`); M13.1 instrumentation
(iter 236); M13.2(a) SSR seed gate (iter 238, GT-6 green iter 240);
M13.2(b).1 no-auto-destroy + self-suspend (iter 249, deployed iter
250); M13.2(b).2 optimistic delete (iter 254); boot-time session
sweep (iter 258, `SWEEP_SESSIONS_ON_BOOT=1` set on `tex-center`
iter 259 — first live sweep removed 16 legacy rows). See git log and
`.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. The
  iter-251 sketch (parse-smoke over `tests_gold/playwright/*.ts`)
  landed iter 252 as `tests_normal/cases/parse_playwright_fixtures.mjs`
  + `test_playwright_fixtures_parse.py` (AST walker for block-scoped
  redeclaration; would have caught the iter-247 wedge at root).

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`) — that pipeline shape wedged iter 148.
