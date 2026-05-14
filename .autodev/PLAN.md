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

As of iter 231 live gold, **GT-A/B/C/D/5/7/8 all GREEN**. M7.4.x
closed iter 231 (warm-doc body-edit silent no-op fixed upstream
in `vendor/supertex` iters 759–764, submodule bumped to `8c3dec0`,
sidecar redeployed and `SIDECAR_IMAGE` repinned, GT-5 verified
GREEN). **GT-6 pinned RED iter 233** (strengthened spec creates
a fresh per-test project, clicks from `/projects`, bounds the
seed sentinel to 500 ms after editor-route interactive; source
actually appears at ~5 s on live). Live focus is now the GT-6
fix. M13.1 instrumentation landed iters 234–236 and the iter-236
live timeline pinned the bottleneck at route→ws-open ~11.5 s
(per-project Machine cold-start gating the WS upgrade). M13.2
direction chosen iter 237: SSR-side seed body so the editor paints
while the Machine cold-starts in parallel. M13.2(a) **landed iter 238**:
SSR seed gate via `getMachineAssignmentByProjectId`, rendered as a
`<pre class="editor-seed">` placeholder inside `.editor`. GT-6 was
re-pointed at `.editor` textContent (not `.cm-content`) and is
expected to flip green on the next live gold run. See M13 below.

Full original GT-5 diagnosis in `.autodev/logs/202.md`; M7.4.x
closing narrative in `.autodev/discussion/230_answer.md`.

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
  Pinned RED iter 233.** User-reported v213 / v231: after
  clicking a project on `/projects`, the editor route loads
  quickly but the seeded `.tex` source can take seconds-to-
  tens-of-seconds to appear. Strengthened GT-6
  (`verifyLiveGt6FastContentAppearance.spec.ts`, rewritten iter
  233) creates a fresh per-test project via the `db` worker
  fixture, navigates `/projects` → clicks the project link
  (matching the user's mouse path), and bounds the
  `documentclass` sentinel in `.cm-content` to 500 ms after the
  editor route becomes interactive (`waitForURL` +
  `domcontentloaded`). `afterEach` reaps the Machine via
  `cleanupProjectMachine` + deletes the row, mirroring GT-8.
  Live smoke iter 233: RED, bound elapsed at 504 ms, source
  actually appeared at 5057 ms — ~10× the target, deterministically
  pinned on every cold-project run. Fix attempts begin iter 234+;
  primary probe is M13.1 `performance.mark` instrumentation on
  the editor hydrate path (connect, Yjs sync, CodeMirror bind, R2
  hydrate, sidecar-readiness wait) to identify which sub-step
  dominates the 5 s gap. Working hypothesis from `231_answer.md`:
  source render is currently gated on something on the sidecar
  Machine critical path when it shouldn't be — authoritative R2
  source should reach CodeMirror in hundreds of ms regardless of
  Machine state.
- **M9.editor-ux.regress.gt7 — daemon crash under rapid typing.
  CLOSED iter 227.** Root cause was an upstream supertex bug
  (`tools/supertex_daemon.c` had no usable rollback target when
  a coalesced edit landed past every extant checkpoint during the
  cold-start window). Upstream fix landed in `vendor/supertex`
  iters 755–758; submodule bumped to `2fb543e` in iter-227 start
  commit; sidecar redeployed iter 227 and the live `SIDECAR_IMAGE`
  digest pinned on `tex-center`. Live verification: GT-8
  (`verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts`) GREEN on
  iter-227 gold pass — `errorFrames=0`, 26 control frames clean.
  Five-iteration narrative compressed: see `225_answer.md`,
  `226_question.md`, `226_answer.md`. Retained regression locks:
  GT-8 (live, cold-project Playwright spec, iter 224),
  `tests_gold/lib/test/supertexColdNewpageCrash.test.mjs` (local,
  iter 225), `tests_gold/lib/test/supertexFilewatcherRace.test.mjs`
  (iter 218), `tests_gold/lib/test/supertexOversizeTarget.test.mjs`
  (iter 217), `tests_gold/lib/test/sidecarColdStartCoalescer.test.mjs`
  (iter 222). `SIDECAR_TRACE_COALESCER` plumbing kept as passive
  diagnostic; consider removal if not used by next coalescer-area
  iteration.
- **M7.4.x — GT-5. CLOSED iter 231.** Root cause was a second
  upstream supertex no-op shape (warm-doc body-edit past every
  extant checkpoint), distinct from the GT-8 cold-start
  `\newpage` shape M7.4 closed for. Upstream fix landed in
  `vendor/supertex` iters 759–764 with two new regression cases
  (`test_cli_daemon_warm_body_edit_noop.sh`,
  `test_cli_daemon_warm_body_edit_long_chain.sh`). Submodule
  bumped to `8c3dec0` in the iter-231 start commit. Sidecar
  redeployed iter 231
  (`deployment-01KRHQ3PE6KY61ZD89XMD7P6YB`,
  sha `b10d59ce82cc…`); `SIDECAR_IMAGE` pinned and control plane
  redeployed
  (`deployment-01KRHQ6ZDCFZFMWGY922VK2QEV`,
  sha `6aa67217b34b…`). Live verification: GT-5
  (`verifyLiveGt5EditUpdatesPreview.spec.ts`) GREEN on iter-231
  isolated run (4.6 s). Retained regression locks:
  GT-5 (live), `supertexWarmDocBodyEditNoop.test.mjs` (local,
  iter 230, deterministic warm-doc body-edit repro driving
  `supertex --daemon` directly). Diagnostic seam from iter 228
  (`CompileSuccess.noopReason` +
  `compile no-op (no pdf-segment shipped)` warn log in
  `apps/sidecar/src/server.ts`) kept in place pending 2–3 full
  gold passes confirming GT-5 stays green; removal tracked in
  `FUTURE_IDEAS.md`.
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
  asset upload"** for non-UTF-8 payloads — text-only is
  insufficient since the real motivation is image/PDF/font drops.

### M12.panels — draggable dividers (post-MVP UX)

Native `<ResizableSplit>` Svelte component, no library. Pointer
capture + CSS custom-property widths. Per-project widths persisted
to `localStorage` keyed by `projectId`. Min widths: ~200px editor,
~200px PDF; file picker collapsible to zero with a re-open chevron.
Single iteration. Local gold: drag → reload → widths persist.

### M13.open-latency — instrument-then-fix (post-MVP UX)

- **M13.1** `performance.mark` at click → route loaded → WS open
  → Yjs sync complete → first text paint → first pdf-segment.
  Surface via iter-187 `?debug=1` toast fan-out. Local gold
  asserts mark ordering + monotonic timestamps.
  - Iter 206 scaffolded: `apps/web/src/lib/editorMarks.ts`
    exports name constants for all five marks plus a `markOnce(name)`
    helper that guards against re-firing and SSR/no-Performance
    environments; editor page wires `EDITOR_ROUTE_MOUNTED` in
    `onMount`.
  - Remaining: wire `EDITOR_WS_OPEN` (first 'connected' snapshot
    from WsClient), `EDITOR_YJS_HYDRATED` (first `snapshot.hydrated`
    true), `EDITOR_FIRST_TEXT_PAINT` (first non-null Y.Text bound
    to the CodeMirror Editor — likely an effect when `text` first
    flips non-null), `EDITOR_FIRST_PDF_SEGMENT` (first non-null
    `snapshot.pdfBytes`). Then add the debug-toast bridge and the
    local ordering spec.
- **M13.2** single highest-impact fix indicated by M13.1 data.
  **M13.1 diagnostic complete iter 236.** GT-6 failure message now
  carries the five-mark timeline; iter-236 live run reported
  `route-mounted=+0ms ws-open=+11546ms yjs-hydrated=+11564ms
  first-text-paint=+1ms first-pdf-segment=(absent)` with the
  seeded `documentclass` source appearing in `.cm-content` at
  +11572 ms. **Verdict: the route→ws-open interval (~11.5 s)
  dominates entirely; yjs-hydrate adds ~18 ms and DOM paint ~8 ms
  on top.** The `first-text-paint=+1ms` figure was an
  instrumentation artefact (Y.Text non-null immediately because
  `doc.getText()` lazily creates it); iter 237 retargeted the
  predicate at `text.length > 0` via a Y.Text observer, so future
  runs will show first-text-paint aligned with yjs-hydrated.
  Cause: the control-plane WS upgrade
  (`apps/web/src/lib/server/wsProxy.ts:200`,
  `upstreamResolver.ts:144`) blocks until the per-project Fly
  Machine is `started` and the sidecar TCP-binds — a cold start.
  Seed content cannot reach the client until that completes, even
  though it is just the static `MAIN_DOC_HELLO_WORLD` template
  (sidecar `persistence.ts:290`).

  **M13.2(a) landed iter 238 — visual seed only (no Y.Doc insert).**
  `apps/web/src/routes/editor/[projectId]/+page.server.ts` now
  queries `getMachineAssignmentByProjectId` and, when the row is
  absent (no WS has ever upgraded for this project, so the sidecar
  has not yet diverged from the canonical template), returns
  `seed = { name: "main.tex", text: MAIN_DOC_HELLO_WORLD }` in the
  page data. The editor svelte renders the seed as a `<pre
  class="editor-seed">` placeholder inside the `.editor` pane
  while `snapshot.hydrated` is still false. The placeholder is
  visual only — it deliberately does *not* carry the `.cm-content`
  class, and the seed bytes are never inserted into the local
  Y.Doc. Two reasons: (1) Yjs CRDT cannot deterministically dedupe
  two independent `t.insert(0, MAIN_DOC_HELLO_WORLD)` operations
  signed with different `clientID`s; an in-Y.Doc seed would
  duplicate the sidecar's identical seed on initial sync; (2)
  every live spec that types into `.cm-content`
  (verifyLiveFullPipeline et al.) must continue waiting for the
  real CodeMirror mount — typing into a `<pre>` would silently
  drop input. GT-6 was updated to poll `.editor` textContent for
  the `documentclass` sentinel rather than `.cm-content`, which is
  the user-visible promise ("source visible in the editor pane
  quickly") and does not constrain the implementation to a
  particular DOM element. Expected effect on the live GT-6
  timeline: appearance time drops from ~5–12 s to under the 500 ms
  bound for fresh cold projects.

  **Known follow-ups for M13.2:**

  - Non-fresh projects (those with a `machine_assignments` row)
    still show the blank `.editor-placeholder` for ~11.5 s on
    reconnect into a cold-stopped Machine. The user-visible UX is
    "blank editor until WS opens" for these. Address by widening
    the seed surface to fetch the *current* persisted source from
    R2/blob-store in `+page.server.ts` when a row exists. Requires
    the web side to read the same blob store the sidecar writes;
    currently the sidecar's `BLOB_STORE` lives only on each
    per-project Machine. Schedule alongside M11.5 binary-asset
    wire work (shared R2 bucket).
  - GT-A currently passes because it polls `.cm-content` which
    only appears after real CodeMirror mounts (post-hydrate); the
    seed placeholder is a separate DOM element. If a future
    iteration consolidates the seed and real editor under a
    single `.cm-content` class, GT-A's invariant must be carried
    through unchanged.
  - `machine_assignments`-row deletion via
    `cleanupProjectMachine` (used by tests and the eventual
    idle-reap path) re-arms the SSR seed gate even though the
    sidecar's blob store may still hold the user's edits. In
    production this is benign while the blob store remains
    per-Machine (a cleaned-up project loses its blobs too); once a
    shared blob store lands, the gate needs to flip from
    "no machine assignment" to "no persisted blob".

Default sequencing (M11–M13 all post-MVP, ordered after MVP-gap
M7.4.x and the GT-E/GT-F/save-feedback work): M13.1 → M12 →
M11.1–M11.4 → M13.2. M11.5 gated on binary-asset wire work.

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
(`apps/sidecar/src/compileCoalescer.ts`). See git log and
`.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Cold-start fresh-project flakiness.** Iter 182 replaced
  single-shot canvas evaluates with a bounded 30s `expect.poll`
  re-locating `.preview canvas` each tick and bumped GT-A's
  `.cm-content` timeout to 120s. If recurrence appears, next step
  is `flyctl machine logs` from a failing run under the
  leaked-subprocess hygiene rules below.
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
