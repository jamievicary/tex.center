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
GREEN). Live focus moves to **GT-6** (slow `.cm-content`
appearance, M9.editor-ux.regress.gt6) as the next open RED.

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

- **M9.editor-ux.regress.gt6 — slow `.cm-content` appearance.**
  User-reported on v213: after `/editor/<id>` navigation, the
  seeded `.tex` source can take up to a minute to appear. GT-6
  (`verifyLiveGt6FastContentAppearance.spec.ts`, iter 214) pins a
  2 s upper bound on warm-project content appearance. Expected
  RED on next gold pass. Fix probe: instrument the Yjs hydrate
  path with M13.1 marks, identify whether connect, sync, or
  CodeMirror bind dominates. See `213_answer.md`.
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
  Likely overlaps M7.0.2 shared-sidecar pool if cold-start
  dominates; in that case M13.2 may collapse into M7.0.2
  sequencing rather than ship separately.

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
