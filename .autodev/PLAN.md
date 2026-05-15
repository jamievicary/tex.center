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
240; delete-project pin (`verifyLiveDeleteProject`) GREEN iter 251;
M17 no-flash pin (`verifyLivePdfNoFlashBetweenSegments`) GREEN
iter 273.

**Open red gold cases (post iter 280):**

- `verifyLivePdfMultiPage` (M15) — blocked on supertex agent's
  response to `vendor/supertex/discussion/764_question.md`
  (filed iter 279). Diagnosis below.
- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — blocked
  on M13.2(b).5 R1 (SSR seed widening, needs shared blob store).
- `verifyLiveGt6LiveEditableState` (M13.2(b).3) — was green
  (iter 256–279), red iter 280 once and may be flaky around the
  suspended-resume boundary; rerun + investigate if it persists.

**Active priority queue:** M13.2(b).5 R1 → M11.1c headless-tree
adoption → M16.aesthetic. M11.5 still gated on shared-R2 binary-
asset work.

## 2. Milestones

### M9.editor-ux — live editor UX bugs

Done and locked: clickable logo, no-flash editor load, compile
coalescer (extracted iter 200 into
`apps/sidecar/src/compileCoalescer.ts`), sustained-typing safety,
toast store + component scaffold, toast consumers for
`file-op-error` and compile errors, debug-mode toggle
(URL/localStorage/Ctrl+Shift+D) with protocol fan-out via
`WsDebugEvent`. Sidecar `assembleSegment` directory-scan fallback
removed.

Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Closed regression slices, all with live locks retained: gt6 slow
`.cm-content` (closed iter 240 via M13.2(a) SSR seed gate; lock
`verifyLiveGt6FastContentAppearance`); gt7 daemon crash under
rapid typing (closed iter 227, upstream `2fb543e`; locks GT-7/8 +
four local supertex tests); M7.4.x GT-5 (closed iter 231,
upstream `8c3dec0`); M9.live-hygiene.leaked-machines (per-project
Machine tagging + orphan-tag sweep landed iter 243/247);
M9.live-hygiene.delete-project (landed iter 245; lock
`verifyLiveDeleteProject`). Narratives:
`.autodev/discussion/225_answer.md`, `226_*`, `230_answer.md`.

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

**Constraint revisited iter 262 (see `260_answer.md`):** the
"native Svelte 5, no third-party tree lib" rule is dropped.
Adopting `@headless-tree/core` + its Svelte adapter — headless
state-machine for expand/select/rename/DnD, our own markup and
styles. Sub-slices:

- **M11.1 rendering substrate. Landed iter 261.**
  `apps/web/src/lib/fileTree.ts` (`buildFileTree`) +
  `apps/web/src/lib/FileTreeNode.svelte`. Data layer survives the
  headless migration; `FileTreeNode.svelte`'s markup is replaced
  in M11.1c. Lock: `apps/web/test/fileTree.test.mjs`.
- **M11.1b** relax `validateProjectFileName` to permit
  `/`-separated segments, update sidecar persistence to
  `mkdir -p` parent dirs on write/rename and reap empty parents
  on delete. Required before M11.3 has any effect.
- **M11.1c (new)** adopt `@headless-tree/core` + its Svelte
  adapter. Wire its state to `buildFileTree` output; replace
  `FileTreeNode.svelte`'s markup with a headless-tree-driven
  view; preserve behaviour. Component test on the wiring.
- **M11.2** create/delete/rename via context menu + keyboard
  (`F2`, `Del`-with-confirm). Reuses extant sidecar verbs.
- **M11.3** create folder via virtual-folder model. Gated on
  M11.1b.
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5** OS drop-upload + drag-out download. Drop-upload
  blocked by FUTURE_IDEAS "binary asset upload"; drag-out
  download unblocked.

### M12.panels — draggable dividers

**Landed iter 257.** Inline implementation in editor `+page.svelte`
with `--col-tree` / `--col-preview` CSS custom properties; editor
pane is `1fr`. Min widths 150/200/200. Per-project widths in
`localStorage["editor-widths:${projectId}"]`. Iter 280 extracted
the layout math into pure-TS `apps/web/src/lib/editorPanelLayout.ts`
with unit test `apps/web/test/editorPanelLayout.test.mjs`. Gold
locks: `tests_gold/playwright/editorPanelDividers.spec.ts`.

### M13.open-latency — instrument-then-fix

- **M13.1 instrumentation. Closed iter 236.**
  `apps/web/src/lib/editorMarks.ts`. Diagnostic conclusion:
  route→ws-open ~11.5s dominates (cold per-project Machine).
- **M13.2(a) SSR seed gate. Closed iter 238, GT-6 green iter 240.**
  `+page.server.ts` returns a `seed` when no `machine_assignments`
  row exists; editor renders `<pre class="editor-seed">` inside
  `.editor` until `snapshot.hydrated`. Load-bearing: seed is
  visual-only, never inserted into the local Y.Doc (CRDT can't
  dedupe two independent `insert(0, …)` ops with different
  `clientID`); placeholder is `<pre>`, not `.cm-content`, so
  existing live specs typing into `.cm-content` still wait for
  the real CodeMirror mount.
- **M13.2(b) — fully-live within 1000 ms on cold access. PARTIAL.**

  1. **M13.2(b).1 no-auto-destroy + self-suspend.** Landed iter
     249/250; resume-bug fix iter 255. `auto_destroy:false` in
     `upstreamFromEnv.ts`; sidecar idle handler in
     `apps/sidecar/src/index.ts` calls
     `POST /machines/{self}/suspend`. On `null` `suspendSelf` or
     fetch-throws, fallback path closes app + `exit(0)`.
     `server.ts` passes `{ rearm }` to `onIdle`. Tests:
     `apps/sidecar/test/idleSuspend.test.mjs`.
  2. **M13.2(b).2 optimistic project delete.** Landed iter 254.
     `deleteProject` deletes DB row first, then fire-and-forget
     `destroyMachine`. Result exposes `destroyComplete` for
     tests; `?/delete` action ignores it. Orphan-tag sweep in
     gold `globalSetup` teardown remains the safety net. Tests:
     `apps/web/test/deleteProject.test.mjs`.
  3. **M13.2(b).3 suspended-resume gold case.** Spec landed iter
     256; green by iter 260 (cmContentReadyMs=857,
     keystrokeAckMs=17). Suspended Machine resumes in ~300 ms;
     no seed widening needed for this path.
     `verifyLiveGt6LiveEditableState.spec.ts`. Red iter 280 once
     — may need flake investigation.
  4. **M13.2(b).4 stopped-state cold-editable pin. RED, expected.**
     `verifyLiveGt6LiveEditableStateStopped.spec.ts` drives
     `POST /machines/{id}/stop`, polls `state==="stopped"`, then
     measures `cmContentReadyMs` / `keystrokeAckMs` vs 1000 ms.
     Gives M13.2(b).5 a concrete target.
  5. **M13.2(b).5 — fix for stopped-state cold load. PARTIAL.**
     - **R1. OPEN.** Widen SSR seed for non-fresh projects:
       fetch persisted source from shared blob store so
       `.cm-content` shows real content during Machine cold-start.
       Prerequisite for (b).4 flipping green. Requires shared
       `BLOB_STORE` binding (web side currently has none).
     - **R2. LANDED iter 267.** Sidecar `createIdleHandler` no
       longer exits on `suspendSelf` failure; throw path logs and
       re-arms instead of `app.close()` + `exit(0)`. Local-dev
       path (`suspendSelf === null`) keeps the close-and-exit
       behaviour. Stopped state still reachable externally (Fly
       host eviction, manual `flyctl machine stop`, gold spec
       `/stop`), so the pin remains RED until R1.

  **Known follow-ups for M13.2:**
  - `machine_assignments`-row deletion via `cleanupProjectMachine`
    re-arms the SSR seed gate even though the sidecar's blob store
    may still hold the user's edits. Benign while the blob store
    remains per-Machine; once shared, the gate must flip from
    "no machine assignment" to "no persisted blob".
  - GT-A passes because it polls `.cm-content` which only appears
    post-hydrate; the seed placeholder is a separate DOM element.
    If a future iteration consolidates seed and real editor under
    one `.cm-content`, GT-A's invariant must be carried through.

### M14.title-bar — centred project title in editor topbar

**Landed iter 264.** `data.project.name` rendered as
`<h1 class="project-title" data-testid="project-title">`. Topbar
layout: `grid grid-template-columns: 1fr auto 1fr`. Title
truncates with `text-overflow: ellipsis`. Lock: third assertion
block in `tests_gold/playwright/editor.spec.ts` —
|title-centre-x − topbar-centre-x| ≤ 2px.

### M15.multipage-preview — page-1-only PDF bug (iter 262)

Promoted from `241_question.md` / `241_answer.md`.

**Fix landed iter 269.** Root cause: sidecar's
`targetPage = maxViewingPage(p)` default in
`apps/sidecar/src/server.ts` `runCompile`. Supertex's daemon
protocol clamps shipouts to `recompile,<N>`; with no viewer ever
setting `viewingPage > 1` (chicken-and-egg), every compile
shipped page 1 only. Fix: pass `targetPage: 0` unconditionally.
Sidecar-level pin
`tests_gold/cases/test_supertex_multipage_emit.py` green.

**Live `verifyLivePdfMultiPage` still RED — separate upstream bug,
escalated iter 279.** Smoking-gun (live sidecar logs, iter 276):

```
supertex: edit /tmp/…/main.tex@85 past last consumed byte 70 — no recompile
```

This is iter-726 supertex short-circuit (see
`vendor/supertex/discussion/726_*`) firing inappropriately on a
document-body insertion. The predicate
(`edit_byte >= read_end_highwater` → no recompile) was designed
for "edit in trailing whitespace past `\end{document}`"; here the
daemon's highwater pins at byte 70 (end of seeded
`\end{document}\n`) while the user inserts new content **before**
`\end{document}`. Highwater never grows; vicious cycle.

Local repro pin `test_supertex_incremental_multipage_emit.py` +
`tests_gold/lib/test/supertexIncrementalMultipageEmit.test.mjs`
PASSES — controlled local shape doesn't trigger the bug, so the
live trigger needs additional state we haven't replicated
(cold-Machine checkpoint restore, partial Yjs sync timing, or
different coalescer cadence). Pin retained as regression lock and
shape-baseline.

**Blocked on supertex agent picking up
`vendor/supertex/discussion/764_question.md` (filed iter 279).**
Options when answer lands: (a) supertex commits a predicate fix
→ roll upstream into `SIDECAR_IMAGE` and redeploy; (b) bug is
downstream → extend local pin until it reproduces.

### M16.aesthetic — writerly chrome retune (iter 262)

Retune site CSS for chrome surfaces (landing, dashboard, editor
topbar/tree/status). Editor and PDF preview content surfaces stay
strictly functional.

Type pair: **Source Serif 4** (body / project names / hero prose;
OFL, variable) + **Inter** (UI affordances, buttons, table
headers; OFL, variable). Self-host both. Monospace in CodeMirror
pane unchanged.

Palette (4 colours): **Paper** `#FAF7F0` + **Ink** `#1F1B16` +
**Quill** `#2E4C6D` (accent / links / primary buttons) +
**Margin** `#D9CFBF` (rules, dividers, chevron tints). Editor
pane background and PDF canvas stay neutral.

Pin: Playwright visual-snapshot diff on `/` and `/projects`, plus
a tight topbar-element snapshot on the editor route.

### M17.preview-render — PDF preview cross-fade

**Landed iter 271 (impl) + iter 273 (pin).**
`apps/web/src/lib/pdfFadeController.ts` owns the per-page fade
state machine (mid-fade interrupt → snapshot, cross-fade,
add/remove wrapper transitions). `PdfViewer.svelte` renders all
pages off-DOM then hands the controller per-page canvas
descriptors; wrappers carry `data-page` so the
IntersectionObserver target is stable across renders. Tests:
`apps/web/test/pdfFadeController.test.mjs` (recording adapter, no
DOM) + live Playwright `verifyLivePdfNoFlashBetweenSegments`.

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
280). See git log and `.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. The
  iter-251 parse-smoke sketch landed iter 252 as
  `tests_normal/cases/parse_playwright_fixtures.mjs` (AST walker
  for block-scoped redeclaration).
- **Dead branch in `clampPanelWidths`** (iter 280 observation):
  the `preview > maxPreview` arm is unreachable given the
  linear-constraint algebra. Either delete it or add a scenario
  test that proves a hit. Park for next `N%10==0` cleanup.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`) — that pipeline shape wedged iter 148.
