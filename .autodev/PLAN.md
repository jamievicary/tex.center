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

As of iter 210 live gold, **GT-A/B/C/D all GREEN, only GT-5 RED**.
Iter 212 added inline diagnostic capture to GT-5; iter 213's live
pass produced a definitive trace: framesSent delta healthy (~1
frame/keystroke), cursor on a body line, three consecutive
`compile-status state:error detail:"supertex-daemon: stdin not
writable"` control frames. Root cause is NOT any of the three
probes the plan predicted — it is missing recovery in the sidecar:
`SupertexDaemonCompiler` cached `readyPromise` forever and never
re-spawned the child after the daemon process died. Iter 213
landed the fix (detect dead-child at top of `compile()` and reset
for re-spawn) plus a respawn test (case 14). Awaiting next live
gold pass to confirm GT-5 → GREEN.

Full original diagnosis in `.autodev/logs/202.md`.

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
- **M9.editor-ux.regress.gt7 — daemon crash under rapid typing.**
  User-reported on v213: zero-delay typing reliably produces a red
  toast (`supertex-daemon: protocol violation: child exited
  (code=134)`). GT-7
  (`verifyLiveGt7RapidTypingDaemonStable.spec.ts`, iter 214) types
  ~570 chars at 0 ms inter-key and asserts no control frame
  matches `protocol violation` / `child exited` /
  `stdin not writable`. GT-7 went GREEN on iter 215's live pass
  — meaning the zero-delay-`type` recipe does **not** reproduce
  the user's crash, so the spec as-committed pins nothing
  (see `215_answer.md`). Two recipe defects: `delay: 0` is not
  realistic typing (no time for WS round-trip between keys),
  and the real-world trigger is *pasting* lines like
  `\newpage X` that swell page count rapidly — implying the
  crash is page-count- / compile-target-dependent, not pure
  keystroke-rate-dependent. Strongest current hypothesis: the
  sidecar sends `recompile,T\n` with a T past the current
  document's page count after a paste of `\newpage`s, hitting
  an assert in supertex's incremental engine.
  **Next probe (TDD, no shortcuts):**
    1. Reproduce the crash manually in a real browser by pasting
       a block of `\newpage X` lines into the seeded project;
       capture the cursor position, page count at crash, and
       the full WS control-frame trace into the iteration log.
       I should do this myself as the agent without involving
       the human.
    2. Only after step 1 produces a concrete recipe, encode it
       in a replacement gold spec and confirm it goes RED with
       the same control-frame shape before committing as the
       pin.
  Coalescer non-overlap unit test demoted to a confidence
  follow-up — it is no longer the next diagnostic. Existing
  GT-7 stays in the tree (cheap, assertion shape is correct)
  until the replacement supersedes or augments it.
  **Revised diagnosis (iter 215, see `214_answer.md`):** supertex
  in `--daemon` mode is stdin-driven only and does not auto-reload
  on disk edits, so the iter-213 "unbatched disk writes race the
  in-flight round" theory does not apply. The only `main.tex`
  writer is `runCompile()` (`apps/sidecar/src/server.ts:334`),
  which is the coalescer's `run` callback — writes already happen
  exactly once per round, before `recompile,T\n`, and Yjs
  doc-updates during a round only set `pending`.
  **Iter 217 probe result (negative):** new gold test
  `test_supertex_oversize_target`
  (`tests_gold/lib/test/supertexOversizeTarget.test.mjs`) drives
  a real `supertex --daemon` directly with (a) `recompile,T`
  where T ∈ {3, 5, 10, 100} against a 2-page doc, and (b) a
  single large-paste edit growing the source by 30 `\newpage X`
  lines. Both pass cleanly. **The "T past page count" and
  "paste-of-newpages" hypotheses are killed.**
  **Iter 218 probe result (also negative):** new gold test
  `test_supertex_filewatcher_race`
  (`tests_gold/lib/test/supertexFilewatcherRace.test.mjs`)
  drives the daemon directly with (1) 10 rapid `main.tex` writes
  with *no* intervening stdin command, then a liveness compile;
  (2) 10 iterations of `writeFile(main.tex); writeStdin("recompile,1\n")`
  in the same microtask. Both pass — no SIGABRT, no protocol
  violation. Sequence (2) produces `WARN no usable rollback
  target` no-op rounds (the same upstream rollback-target-missing
  path from iter 188) for the rapid back-to-back rounds, not
  crashes.
  **Model correction (iter 219, see `218_answer.md`):** the
  iter-217 reading of `supertex: edit detected at …/main.tex:NN`
  as evidence of an *asynchronous* file-watcher was wrong. Those
  lines are emitted **inside `recompile,T` handling** when the
  daemon inspects input files to choose a resume checkpoint;
  there is no inotify-style watcher. The "stdin event-loop"
  stderr marker is exactly what it says — stdin only. The
  iter-215 invariant — *supertex `--daemon` is stdin-driven
  only* — therefore stands. The iter-218 probes still serve as
  regression locks on stdin-side tolerance under paired
  disk-write + recompile sequences (which is what the sidecar
  actually does), but they don't probe an asynchronous-watcher
  race because there isn't one to probe.
  **Next probe candidates (revised priority):**
  (a) **Sidecar-side audit** — re-read
  `apps/sidecar/src/compileCoalescer.ts` and `runCompile` in
  `apps/sidecar/src/server.ts` for any path that can issue a
  second `recompile,T` before the previous round-done arrives,
  or any path that mutates `main.tex` after `recompile,T` has
  been sent but before `round-done`. Either *would* surface as a
  protocol-violation flavour error and is consistent with the
  stdin-only model.
  (b) **Real-browser repro** by pasting `\newpage X` lines into
  the seeded project (the original PLAN step 1). Sidecar audit
  may already explain it; if not, this captures the actual
  user-reported sequence with cursor + page count + WS trace.
- **M7.4.x — GT-5 only.** GT-A/B/C/D green on iter 210. Iter
  213's diagnostic-driven fix (`SupertexDaemonCompiler` now
  detects dead-child state and re-spawns on next `compile()`,
  with paired unit-test case 14) is the candidate. Waiting on
  the next live gold pass to confirm GT-5 → GREEN. If still RED,
  reopen the diagnostic — the iter-212 capture stays in place.
  Open upstream question (separable, not blocking): *why* does
  the daemon process exit between GT-4 and GT-5? Hypotheses:
  daemon crash on specific GT-4 input, idle timeout, Fly OOM
  reaper. Add a sidecar-side ring buffer of `[supertex-daemon
  stderr]` lines around the death event in a future iteration
  if recurrence justifies it.
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
