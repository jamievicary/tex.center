# tex.center — Plan

FREEZE-lift recorded: M8.pw.4 went green automatically in iter
169, was confirmed at iter 170, and the reused-pipeline variant
landed at iter 171. The "no other work proceeds until live spec
green" gate the FREEZE block enforced is satisfied. Normal cron
behaviour (`N%10==0` refactor, `N%10==1` plan-review) resumes.

Iter 180 deferred the refactor cron to fix a two-iter regression
in `verifyLiveFullPipeline.spec.ts` (`.cm-content` wait was sized
for the pre-no-flash world; bumped 30s → 120s to match cold-start
TCP-probe budget). Refactor cron rolls onto iter 181 alongside the
N%10==1 plan-review; if that compounds, one of them gets deferred
one more iter with log notation.

## 1. Recent state

Live product (https://tex.center): core loop works end-to-end —
login + project list + project open + edit → save → PDF render +
refresh persistence have all been confirmed via the M8.pw.4 fresh
spec running automatically on each deploy. Sidecar runs per-project
Fly Machines in `fra` with TCP-probe cold-start handling, 1024MB
RAM, scale-to-zero idle-stop (but idle-stop itself is currently
broken — see `173b_question.md`). Auth (OAuth allowlist), file
CRUD, WS proxy with 6PN dial, control-plane → sidecar pin via
`SIDECAR_IMAGE` secret all live and tested. M7.0.2 shared-sidecar
pool (`tex-center-sidecar` app with two `app`-tagged deployment
machines) exists alongside.

Most-recent inflection points (each maps to a discussion question):

- **Editor UX gaps** (`172_question.md`): user-visible bugs the
  green M8.pw.4 doesn't cover — no-flash initial load, broken
  initial-PDF render, compile-coalescer overlap, missing save-
  feedback affordance, no toast UX, logo doesn't navigate. Four
  failing-on-purpose gold specs (GT-A through GT-D) landed at
  iter 173 to lock in TDD.
- **Resource hygiene** (`173b_question.md`): live specs leaked
  per-project Fly Machines because their `afterEach` only
  deleted the DB row, and idle-stop was broken for
  never-connected machines. Spec teardown fixed iter 175;
  idle-stop fixed iter 176 (timer now arms at sidecar startup,
  not only on `1→0` transition).
- **Debug protocol toasts** (`174_question.md`): augments the
  toast component design with debug-mode categories. Folds into
  the toast UX milestone.

Operator-gated work still outstanding: M8.pw.3.3 real-OAuth
callback spec (needs GCP test client + `TEST_OAUTH_BYPASS_KEY`
secret on Fly).

## 2. Milestones

### M9.resource-hygiene — Fly Machine leak + idle-stop

Delivers: live specs destroy their per-project Machine on
teardown; idle-stop fires reliably in prod; a gold-suite guardrail
asserts Machine count stays under a configurable threshold.
See `173b_question.md` + `173b_answer.md`.

Two slices:

- **Spec teardown + count guardrail.** Landed iter 175.
  `cleanupLiveProjectMachine` helper at
  `tests_gold/playwright/fixtures/cleanupLiveProjectMachine.ts`
  wraps the existing `cleanupProjectMachine` primitive with
  env-derived `FLY_API_TOKEN` + `SIDECAR_APP_NAME` (default
  `tex-center-sidecar`); called from `afterEach` in
  `verifyLiveFullPipeline`, `verifyLiveEditTriggersFreshPdf`,
  `verifyLiveInitialPdfSeeded`, `verifyLiveNoFlashLoad`,
  `verifyLiveSustainedTyping`. Reused-pipeline spec deliberately
  unchanged. Count guardrail at
  `tests_gold/cases/test_sidecar_machine_count.py` calls Fly
  Machines API, asserts ≤ `TEXCENTER_MAX_SIDECAR_MACHINES`
  (default 5), lists offenders on breach. Status: **done**.
- **Idle-stop diagnosis + fix.** Landed iter 176. Bug: arm path
  was only the `viewerCount: 1→0` transition in
  `noteViewerRemoved`, so a Fly Machine that booted without ever
  receiving a WS handshake never armed the timer and ran
  forever (confirmed via `flyctl logs` on
  `7815104f060d28`: only `Server listening`, no viewer-added).
  Fix in `apps/sidecar/src/server.ts`: factored arm into
  `armIdleTimer()` and called it once at `buildServer` init;
  first viewer-add clears it. Regression unit test added as
  case 5 in `apps/sidecar/test/serverIdleStop.test.mjs`. Status:
  **done**. Live regression spec deferred — the unit test
  covers the bug shape, and a 12-min wallclock live variant has
  poor cost/benefit while the per-spec teardown (iter 175) and
  count guardrail already lock the cleanup.

### M9.editor-ux — live editor UX bugs (TDD'd via gold)

Delivers: no flash of empty editor on load, initial PDF renders
without typing, compile coalescer prevents overlap errors,
sustained-typing path is correct, save-feedback indicator,
clickable logo, toast widget with both user and debug categories.
See `172_question.md`, `172_answer.md`, `174_question.md`,
`174_answer.md`.

Gold specs landed (failing-on-purpose) at iter 173:
GT-A (`verifyLiveNoFlashLoad`), GT-B
(`verifyLiveInitialPdfSeeded`), GT-C
(`verifyLiveEditTriggersFreshPdf`), GT-D
(`verifyLiveSustainedTyping`). Code-side slices:

- **Logo → /projects.** Landed iter 177. `<div class="brand">`
  is now `<a href="/projects" class="brand">` with inherit-color
  + hover-underline styling so the visual remains unchanged.
  Status: **done**.
- **No-flash editor.** Landed iter 177. `WsClientSnapshot` gains
  a `hydrated: boolean`, flipped true on the first `doc-update`
  or `file-list` frame in `apps/web/src/lib/wsClient.ts`. The
  editor page renders `<Editor>` only when `snapshot.hydrated`,
  otherwise a same-dimensioned `.editor-placeholder` div holds
  the grid cell. Unit test
  `apps/web/test/wsClientHydrated.test.mjs` (5 cases) locks the
  flag's transition semantics. Makes GT-A green (verifies live).
  Status: **done**.
- **Compile coalescer.** Landed iter 178. State machine in
  `apps/sidecar/src/server.ts`: `compileInFlight`,
  `pendingCompile`, `debounceTimer`, `highestEmittedShipoutPage`
  on `ProjectState`. `kickCompile` sets pending + (re)arms the
  debounce; `maybeFireCompile` is edge-triggered and only fires
  when idle. `runCompile().finally()` clears in-flight and
  re-arms the debounce if pending. `view` frame fires-through
  via `maybeKickForView` only when idle AND
  `maxViewingPage > highestEmittedShipoutPage`. `CompileSuccess`
  gained an optional `shipoutPage`; the daemon compiler surfaces
  `events.maxShipout` when ≥0. Unit test at
  `apps/sidecar/test/serverCompileCoalescer.test.mjs` covers
  (1) 50-update burst during in-flight produces exactly one
  follow-up call, (2) error path clears in-flight, (3)
  view-fire-through gated by highestEmittedShipoutPage, (4)
  quiescent path. Expected to flip GT-B/C/D green on the next
  live deploy. Status: **done**.
- **Toast UX + debug toasts.** Component + store landed iter
  179. `apps/web/src/lib/toastStore.ts` exposes
  `createToastStore({ now, setTimeout, clearTimeout })` (DI for
  tests) and a module singleton `toasts`. Push admits
  `{ category, text, ttlMs?, persistent?, aggregateKey? }`.
  Categories: `info` / `success` / `error` (user-visible),
  `debug-blue` / `debug-green` / `debug-orange` / `debug-grey`
  / `debug-red` (debug-mode). Per-category default TTLs
  (3–6s user, 2–4s debug). Aggregation: same `aggregateKey`
  within `AGGREGATE_WINDOW_MS` (500ms) of the previous push
  merges into the existing toast, bumps `count`, updates
  `text`, and re-arms the TTL. Persistent toasts (`persistent:
  true`) have no TTL and require explicit `dismiss(id)`.
  `apps/web/src/lib/Toasts.svelte` renders a fixed-bottom-
  right stack reading the singleton; mounted in
  `apps/web/src/routes/+layout.svelte`. Unit test
  `apps/web/test/toastStore.test.mjs` covers 7 cases (push +
  subscribe, default TTL by category, explicit ttlMs, merge
  with count bump and text update, distinct keys/no-key don't
  merge, dismiss clears its TTL, merge re-arms TTL). Status:
  **scaffold done; consumers pending**.
  Pending follow-up slices:
  1. Debug-mode toggle (`localStorage.debug==="1"` or
     `?debug=1`) + WS-client fan-out to debug toasts: blue=
     `pdf-segment`, green=outgoing Yjs op, orange=
     `compile-status`, grey=`hello`/`file-list`, red=
     `file-op-error`. Hidden keyboard shortcut (Ctrl+Shift+D).
     Wire as a subscriber to `WsClient.onChange` / outgoing
     send hook.
  2. User-facing consumers: `file-op-error` → red toast (dedup
     by reason), compile error → error toast (dedup by detail),
     successful save → success toast (post-debounce).
  3. GT-E (local Playwright): info/success/error spawn the
     right toast, dedup by repeated `file-op-error` produces
     `×N` badge.
  4. GT-F (local Playwright): `?debug=1` flips localStorage,
     types a single character, observes a green `Yjs op` toast
     and (after compile) a blue `pdf-segment` toast; rapid
     typing aggregates green into a single `×N` toast; without
     the flag, none of these toasts appear.
- **Save-feedback affordance.** `SyncStatus` indicator with
  idle/in-flight/error states sourced from Yjs provider sync
  state acked by sidecar persistence (NOT per-keystroke).
  Local Playwright + live Playwright variants. Status:
  **pending**.

### M7.4.2 — upstream supertex daemon serialise/restore

Delivers: PR against `github.com/jamievicary/supertex` adding
state serialisation. Gates checkpoint persistence ever doing
anything observable. Status: **deferred**, post-MVP hardening.

### M7.5 — daemon-adoption hardening

Delivers: remaining slices for the supertex daemon adoption —
rate limits, observability surface, narrower deploy tokens.
Status: **deferred**, post-MVP.

### M8.pw.3.3 — real-OAuth-callback live activation

Delivers: `verifyLiveOauthCallback.spec.ts` runs against the
live deploy. Requires operator step: create test OAuth client
in GCP (redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push
`TEST_OAUTH_BYPASS_KEY` to Fly secrets. Code-side complete.
Status: **operator-gated**.

### Completed

M0–M7.5.5, M8.smoke.0, M8.pw.0–M8.pw.3.2, M8.pw.4, M8.pw.4-reused,
M9.observability (iter 163 ws-proxy + sidecar logging),
M9.cold-start-retry (iter 164 + iter 168 TCP-probe). See git log
and `.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Per-project Fly Machines vs shared sidecar.** Current model
  is per-project. Shared-pool exists as the app-tagged
  deployment machines but isn't routed to. Decision deferred
  to post-MVP.
- **`apps/sidecar` test scaffolding.** Compile-coalescer slice
  needs a fake-compiler harness that doesn't exist yet. Either
  invent it inside the coalescer iter (likely) or carve out as
  prep slice if the iter overruns.
- **Reused-pipeline spec behaviour after compile-coalescer
  lands.** The reused path has Y.Doc state accumulating across
  runs and uses Ctrl+A + Backspace to clear it. Coalescer may
  interact with the clearing burst — watch for regression.
- **Toast component shape decision lives in the toast iter.**
  API is `{ category, text, ttlMs, persistent, aggregateKey }`
  per `174_answer.md`; finalised when the code lands.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. No
  longer frozen; can be picked up by an iter when no critical-
  path work is queued.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without `timeout
--kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`). That pipeline shape is what wedged iter 148.
