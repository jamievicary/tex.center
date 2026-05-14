# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra` with TCP-probe cold-start, 1024MB RAM, scale-to-zero
idle-stop. M7.0.2 shared-sidecar pool (`tex-center-sidecar` app
with `app`-tagged deployment machines) exists alongside but isn't
routed to. Iteration indicator wired through Dockerfile build-arg
into the topbar (regression-locked).

All eight live gold cases (GT-A/B/C/D/5/6/7/8) GREEN as of iter
240. M13.1 instrumentation (iters 234–237) pinned the open-latency
bottleneck at route→ws-open ~11.5 s (per-project Machine cold
start); **M13.2(a) SSR seed gate landed iter 238 and flipped GT-6
green at the 500 ms bound on the iter-240 live run.** Iter-228
diagnostic seam (`CompileSuccess.noopReason`) removed iter 240
after GT-5 stayed green iters 231→239.

**Current live focus: delete-project verb + UI** (next slice of
M9.live-hygiene per `.autodev/discussion/241_answer.md`). Iter 243
landed the metadata-tagging primitive (fix shape (c)) so the
guardrail is self-triaging and the delete verb has a stable key.

Full original GT-5 diagnosis in `.autodev/logs/202.md`; M7.4.x
closing narrative in `.autodev/discussion/230_answer.md`; M13
instrumentation timeline in `.autodev/logs/236.md`.

## 2. Milestones

### M9.editor-ux — live editor UX bugs (TDD via gold)

Done and locked: clickable logo, no-flash editor load, compile
coalescer (extracted iter 200), sustained-typing safety, toast
store + component scaffold, toast consumers for `file-op-error`
and compile errors, debug-mode toggle
(URL/localStorage/Ctrl+Shift+D) with protocol fan-out via
`WsDebugEvent`. Sidecar `assembleSegment` directory-scan fallback
removed. Gold restructure (iter 197 + 210): warm-up + project
creation in `globalSetup.ts`
(`fixtures/liveProjectBootstrap.ts`), test-scoped fixture reads
env, per-test `timeout` = 45s — budgets are diagnostic again.

Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Remaining slices:

- **M9.editor-ux.regress.gt6 — slow `.cm-content` appearance.
  CLOSED iter 240.** GT-6
  (`verifyLiveGt6FastContentAppearance.spec.ts`) bounds the
  seeded-`documentclass` sentinel inside `.editor` to 500 ms after
  the editor route becomes interactive. Driven RED iter 233 (~5 s
  actual appearance), diagnosed via M13.1 instrumentation iters
  234–236 (route→ws-open dominated at ~11.5 s on cold Machine),
  fixed iter 238 by M13.2(a) SSR seed gate (see M13 below). Live
  green iter 240.
- **M9.editor-ux.regress.gt7 — daemon crash under rapid typing.
  CLOSED iter 227.** Upstream supertex rollback-target bug fixed
  in `vendor/supertex` iters 755–758 (submodule bumped to
  `2fb543e` iter 227). Sidecar redeployed; `SIDECAR_IMAGE` repinned.
  Live GT-8 green iter 227, locks retained: GT-8 (live);
  `supertexColdNewpageCrash.test.mjs`, `supertexFilewatcherRace.test.mjs`,
  `supertexOversizeTarget.test.mjs`, `sidecarColdStartCoalescer.test.mjs`
  (local). Narrative: `.autodev/discussion/225_answer.md`,
  `226_question.md`, `226_answer.md`.
- **M7.4.x — GT-5. CLOSED iter 231.** Second upstream supertex
  no-op shape (warm-doc body-edit past every extant checkpoint),
  distinct from the GT-8 `\newpage` shape. Fixed in
  `vendor/supertex` iters 759–764 (submodule bumped to `8c3dec0`
  iter 231); sidecar + control plane redeployed. Locks retained:
  GT-5 (live) + `supertexWarmDocBodyEditNoop.test.mjs` (local,
  iter 230). Iter-228 diagnostic seam removed iter 240.
- **M9.live-hygiene.leaked-machines.** Fix shape (c) **LANDED
  iter 243**: `apps/web/src/lib/server/upstreamResolver.ts::ensureMachineId`
  now tags every Machine it creates with
  `config.metadata.texcenter_project=<projectId>`, and
  `test_machine_count_under_threshold` excludes shared-pool
  Machines (`config.metadata.fly_process_group=="app"`) from the
  count and includes the `texcenter_project` tag in the breach
  message. Guardrail GREEN as of iter 243 (was RED at 6 total in
  iters 241–242 — 4 untagged legacy leaks + 2 shared-pool;
  filtering drops it to 4 ≤ 5). The 4 untagged leakers remain
  alive and must be destroyed by hand (`flyctl machines destroy`)
  to fully reset state; new control-plane machines will all be
  tagged and self-identify on future breaches. Next slice on this
  milestone is the delete-project verb (see
  `.autodev/discussion/241_answer.md`) which will key its destroy
  call off the same tag.
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

- **M11.1** read-only collapsible tree (folders inferred from
  `/`-separated paths). Replaces flat picker.
- **M11.2** create/delete/rename via context menu + keyboard
  (`F2`, `Del`-with-confirm). Reuses extant sidecar verbs.
- **M11.3** create folder via virtual-folder model (no sentinel
  file; folder materialises on first child).
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5** OS-drop upload. **Blocked by FUTURE_IDEAS "binary
  asset upload"** for non-UTF-8 payloads.

### M12.panels — draggable dividers (post-MVP UX)

Native `<ResizableSplit>` Svelte component, no library. Pointer
capture + CSS custom-property widths. Per-project widths persisted
to `localStorage` keyed by `projectId`. Min widths: ~200px editor,
~200px PDF; file picker collapsible to zero with a re-open chevron.
Single iteration. Local gold: drag → reload → widths persist.

### M13.open-latency — instrument-then-fix (post-MVP UX)

- **M13.1 — instrumentation. CLOSED iter 236.** `performance.mark`
  at click → route loaded → WS open → Yjs sync complete → first
  text paint → first pdf-segment. Helpers in
  `apps/web/src/lib/editorMarks.ts`. M13.1 diagnostic conclusion
  (iter 236 live timeline): route→ws-open ~11.5 s dominates
  entirely; yjs-hydrate adds ~18 ms and DOM paint ~8 ms on top.
  Cause: control-plane WS upgrade (`apps/web/src/lib/server/wsProxy.ts:200`,
  `upstreamResolver.ts:144`) blocks until the per-project Fly
  Machine is `started` and the sidecar TCP-binds — a cold start.
- **M13.2(a) — SSR seed gate. LANDED iter 238, closed GT-6 iter
  240.** `apps/web/src/routes/editor/[projectId]/+page.server.ts`
  queries `getMachineAssignmentByProjectId` and, when the row is
  absent, returns `seed = { name: "main.tex", text:
  MAIN_DOC_HELLO_WORLD }` in page data; the editor renders the
  seed as a `<pre class="editor-seed">` placeholder *inside*
  `.editor` while `snapshot.hydrated` is still false. Two
  load-bearing design calls:
  1. **Seed is visual-only, never inserted into the local Y.Doc.**
     Yjs CRDT cannot deterministically dedupe two independent
     `t.insert(0, MAIN_DOC_HELLO_WORLD)` ops signed with different
     `clientID`s; an in-Y.Doc seed would duplicate the sidecar's
     identical seed on initial sync.
  2. **Placeholder DOM element is `<pre class="editor-seed">`, not
     `.cm-content`.** Every live spec that types into `.cm-content`
     (verifyLiveFullPipeline et al.) must continue waiting for the
     real CodeMirror mount — typing into the `<pre>` would silently
     drop input. GT-6 polls `.editor` textContent instead, which is
     the user-visible promise.

  **Known follow-ups for M13.2:**

  - Non-fresh projects (those with a `machine_assignments` row)
    still show the blank `.editor-placeholder` for ~11.5 s on
    reconnect into a cold-stopped Machine. Widen the seed surface
    to fetch the *current* persisted source from R2/blob-store in
    `+page.server.ts` when a row exists. Requires the web side to
    read the same blob store the sidecar writes; currently
    `BLOB_STORE` lives only on each per-project Machine. Schedule
    alongside M11.5 binary-asset wire work (shared R2 bucket).
  - GT-A currently passes because it polls `.cm-content` which
    only appears after real CodeMirror mounts (post-hydrate); the
    seed placeholder is a separate DOM element. If a future
    iteration consolidates the seed and real editor under a single
    `.cm-content` class, GT-A's invariant must be carried through.
  - `machine_assignments`-row deletion via `cleanupProjectMachine`
    re-arms the SSR seed gate even though the sidecar's blob store
    may still hold the user's edits. Benign while the blob store
    remains per-Machine; once a shared blob store lands, the gate
    must flip from "no machine assignment" to "no persisted blob".

Default sequencing: **M9.live-hygiene.leaked-machines next**, then
M12 → M11.1–M11.4 → M13.2 widening. M11.5 gated on binary-asset
wire work.

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
(iter 236); M13.2(a) SSR seed gate (iter 238, GT-6 green iter 240).
See git log and `.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`) — that pipeline shape wedged iter 148.
