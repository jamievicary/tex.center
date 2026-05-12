# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review. Iter 192 owes a
refactor cron (190 deferred to fix the iter-189 gold regression;
no further defer budget without a separately-justified critical
bug).

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra` with TCP-probe cold-start, 1024MB RAM, scale-to-zero
idle-stop. M7.0.2 shared-sidecar pool (`tex-center-sidecar` app
with `app`-tagged deployment machines) exists alongside but isn't
routed to. Iteration indicator wired through Dockerfile build-arg
into the topbar (regression-locked).

The remaining user-visible regression is **edit→preview**: live
GT-3 and GT-5 are RED by design. Sidecar-side fallback that masked
the bug was removed at iter 189; the live failure mode is now
`compile-status running` → `idle` with **no** `pdf-segment` frame.
Root cause is upstream: supertex `--daemon` `process_event`
rollback is a no-op when it finds no usable checkpoint after a
post-initial-compile edit.

## 2. Milestones

### M9.editor-ux — live editor UX bugs (TDD via gold)

Done and locked: clickable logo, no-flash editor load, compile
coalescer, sustained-typing safety, toast store + component
scaffold, toast consumers for `file-op-error` and compile errors,
debug-mode toggle (URL/localStorage/Ctrl+Shift+D) with protocol
fan-out via `WsDebugEvent`. Sidecar `assembleSegment` directory-
scan fallback removed; `compile()` short-circuits to
`{ segments: [] }` on a no-op round.

Toast store API (frozen iter 179):
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500ms re-arms TTL and bumps `count`.

Remaining slices:

- **M7.4.x — upstream supertex `process_event` rollback fix.**
  Blocks live GT-3 and GT-5. Next step: capture a minimal repro
  against `vendor/supertex`'s daemon harness (initial compile,
  then edit, then observe `process_event` returns no rollback
  target), then PR upstream. With the sidecar fallback gone, no
  further client-side workaround is available — this is the only
  remaining path to green GT-3/GT-5.
- **GT-E (local Playwright).** info/success/error spawn the right
  toast; repeated `file-op-error` produces a `×N` aggregated
  badge.
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

### M8.pw.3.3 — real-OAuth-callback live activation

Code complete. Operator-gated: create test OAuth client in GCP
(redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push `TEST_OAUTH_BYPASS_KEY`
to Fly secrets. Then `verifyLiveOauthCallback.spec.ts` un-skips.

### M7.4.2 — upstream supertex serialise/restore

PR against `github.com/jamievicary/supertex` adding state
serialisation. Gates checkpoint persistence ever being observable.
**Deferred**, post-MVP hardening. Distinct from M7.4.x above
(which is the rollback-target bug, not serialisation).

### M7.5 — daemon-adoption hardening

Rate limits, observability surface, narrower deploy tokens.
**Deferred**, post-MVP.

### Completed

M0–M7.5.5, M8.smoke.0, M8.pw.0–M8.pw.4-reused, M9.observability
(iter 163), M9.cold-start-retry (iter 164 + 168 TCP-probe),
M9.resource-hygiene (iter 175 spec teardown + count guardrail;
iter 176 idle-stop arm at startup). See git log and
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
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`. Can be
  picked up by an iter when no critical-path work is queued.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:true`
paired with an explicit kill before iteration end. Never pipe
such a command into a downstream that waits for EOF (`… | tail
-N`, `… | head`) — that pipeline shape wedged iter 148.
