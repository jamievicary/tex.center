# tex.center — Plan

Normal cron resumes: `N%10==0` refactor, `N%10==1` plan-review.
Iter 180 deferred the refactor cron to fix a regression in the
M8.pw.4 gating spec; iter 181 takes the plan-review and rolls the
refactor cron onto iter 182. If that compounds, one of them
defers one more iter with log notation.

## 1. Recent state

Live product (https://tex.center): core loop works end-to-end —
login + project list + project open + edit → save → PDF render +
refresh persistence. Sidecar runs per-project Fly Machines in
`fra` with TCP-probe cold-start handling, 1024MB RAM, scale-to-zero
idle-stop. Auth (OAuth allowlist), file CRUD, WS proxy with 6PN
dial, control-plane → sidecar pin via `SIDECAR_IMAGE` secret all
live and tested. M7.0.2 shared-sidecar pool
(`tex-center-sidecar` app with two `app`-tagged deployment
machines) exists alongside.

Recent inflection points (each maps to a discussion question):

- **Editor UX gaps** (`172_question.md`): user-visible bugs the
  green M8.pw.4 doesn't cover — no-flash initial load, broken
  initial-PDF render, compile-coalescer overlap, missing save-
  feedback affordance, no toast UX, logo doesn't navigate. Four
  failing-on-purpose gold specs (GT-A through GT-D) landed at
  iter 173 to lock in TDD. Logo (iter 177), no-flash (iter 177),
  compile coalescer (iter 178), toast scaffold (iter 179) all
  done. Toast consumers and save-feedback still pending.
- **Resource hygiene** (`173b_question.md`): live specs leaked
  per-project Fly Machines; idle-stop was broken for
  never-connected machines. Spec teardown fixed iter 175;
  idle-stop fixed iter 176 (timer arms at sidecar startup, not
  only on `1→0` transition). Count guardrail live in gold.
- **Debug protocol toasts** (`174_question.md`): folds into
  the toast UX milestone as a follow-up slice on the scaffold.

Operator-gated work still outstanding: M8.pw.3.3 real-OAuth
callback spec (needs GCP test client + `TEST_OAUTH_BYPASS_KEY`
secret on Fly).

## 2. Milestones

### M9.editor-ux — live editor UX bugs (TDD'd via gold)

Delivers: no flash, initial PDF, compile coalescer, sustained
typing, save-feedback, clickable logo, toast widget with user +
debug categories. See `172/174_question.md`+`_answer.md`.

Done: logo→/projects (iter 177), no-flash editor (iter 177),
compile coalescer (iter 178), toast store + component scaffold
(iter 179). Remaining slices:

- **Toast consumers.** `file-op-error` → red toast (dedup by
  reason), compile error → error toast (dedup by detail),
  successful save → success toast (post-debounce). User-facing
  only — no `?debug=1` yet.
- **Debug-mode toggle + protocol fan-out.**
  `localStorage.debug==="1"` or `?debug=1`; Ctrl+Shift+D
  shortcut. Subscribe to `WsClient.onChange` + outgoing-send
  hook and emit debug toasts: blue=`pdf-segment`, green=outgoing
  Yjs op, orange=`compile-status`, grey=`hello`/`file-list`,
  red=`file-op-error`.
- **GT-E (local Playwright).** info/success/error spawn the
  right toast; dedup by repeated `file-op-error` produces a
  `×N` badge.
- **GT-F (local Playwright).** `?debug=1` flips localStorage;
  typing a single char produces a green Yjs-op toast and (after
  compile) a blue pdf-segment toast; rapid typing aggregates
  into one green `×N` toast; without the flag, no debug toasts.
- **Save-feedback affordance.** `SyncStatus` indicator
  (idle/in-flight/error) sourced from Yjs provider sync state
  acked by sidecar persistence (NOT per-keystroke). Local +
  live Playwright variants.

Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

### M8.pw.3.3 — real-OAuth-callback live activation

Delivers: `verifyLiveOauthCallback.spec.ts` runs against the
live deploy. Operator step: create test OAuth client in GCP
(redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push `TEST_OAUTH_BYPASS_KEY`
to Fly secrets. Code-side complete. Status: **operator-gated**.

### M7.4.2 — upstream supertex daemon serialise/restore

Delivers: PR against `github.com/jamievicary/supertex` adding
state serialisation. Gates checkpoint persistence ever doing
anything observable. Status: **deferred**, post-MVP hardening.

### M7.5 — daemon-adoption hardening

Remaining slices for the supertex daemon adoption — rate limits,
observability surface, narrower deploy tokens. Status:
**deferred**, post-MVP.

### Completed

M0–M7.5.5, M8.smoke.0, M8.pw.0–M8.pw.3.2, M8.pw.4, M8.pw.4-reused,
M9.observability (iter 163 ws-proxy + sidecar logging),
M9.cold-start-retry (iter 164 + 168 TCP-probe), M9.resource-hygiene
(iter 175 spec teardown + count guardrail; iter 176 idle-stop
arm at startup; live regression deferred — unit test covers
shape and count guardrail locks cleanup). See git log and
`.autodev/logs/` for detail.

## 3. Open questions / known gaps

- **Cold-start fresh-project flakiness.** `verifyLiveFullPipeline`
  (M8.pw.4) and `verifyLiveGt1NoFlashLoad` (GT-A) are the only
  two specs that hit a freshly-created project + cold-started Fly
  Machine. They have flaked across iters 178–180: M8.pw.4 red
  every iter since 178 (most-recent failure was "preview canvas
  near-white" after the 120s `.cm-content` bump in iter 180, i.e.
  hydration completed but PDF render didn't paint), GT-A red in
  177 and 180 but green in 178/179. Reused-pipeline spec is
  green throughout, so the warm-machine path is sound. Likely
  root causes to investigate: (a) Fly cold-start tail latency,
  (b) compile coalescer interaction with the very first
  `pdf-segment` for a brand-new Y.Doc, (c) PdfViewer canvas
  paint racing the first `pdf-segment` arrival. Iter 182 (after
  the refactor cron) takes this as primary work — start by
  pulling logs from a failing M8.pw.4 run and instrumenting the
  pdf-segment → canvas paint path.
- **Per-project Fly Machines vs shared sidecar.** Current model
  is per-project. Shared-pool exists as the app-tagged
  deployment machines but isn't routed to. Decision deferred
  to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. No
  longer frozen; can be picked up by an iter when no
  critical-path work is queued.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without `timeout
--kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`). That pipeline shape is what wedged iter 148.
