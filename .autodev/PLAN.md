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

### M10.branding — logo assets (post-MVP UX)

`assets/logo_stacked.svg` and `assets/logo_linear.svg` are in tree.
Inline via Vite `?raw` import (no static fetch; enables
`currentColor` theming). `/projects` page: stacked mark above the
project list. Topbar: replace `tex.center` wordmark with linear
mark, preserving the iter-177 `<a href="/projects">` wrapper and
the iter-185 indicator slot. Existing topbar/landing/projects gold
specs need to swap wordmark-text assertions for image/SVG
aria-label assertions. Single iteration. See `discussion/191_answer.md`.

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
- **M13.2** single highest-impact fix indicated by M13.1 data.
  Likely overlaps M7.0.2 shared-sidecar pool if cold-start
  dominates; in that case M13.2 may collapse into M7.0.2
  sequencing rather than ship separately.

Default sequencing (M10–M13 all post-MVP, ordered after MVP-gap
M7.4.x and the GT-E/GT-F/save-feedback work): M10 → M13.1 →
M12 → M11.1–M11.4 → M13.2. M11.5 gated on binary-asset wire
work.

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
