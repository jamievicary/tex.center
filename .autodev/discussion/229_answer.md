# 229_answer — Local GT-5 silent-no-op repro landed; halting

## Result

Local headless repro built and confirmed RED:

- `tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs` —
  spawns `supertex --daemon` directly through
  `SupertexDaemonCompiler`, seeds with the standard
  `MAIN_DOC_HELLO_WORLD` template, replays the GT-D
  `Coalescer probe …` typing build-up as 8 coalesced growth
  steps, then replays the GT-5 `\n\section{New Section}\n`
  insertion as 3 coalesced sub-rounds. Asserts every round
  emits ≥1 shipout (`segments.length ≥ 1`). Surfaces every
  no-op round with `noopReason` and source tail in the failure
  message.
- `tests_gold/cases/test_supertex_warm_doc_body_edit_noop.py` —
  Python wrapper following the
  `test_supertex_cold_newpage_crash.py` pattern.

## Smoke-test (this iteration)

`pnpm exec tsx tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs`
reproduces the upstream bug deterministically:

```
supertex daemon emitted silent no-op round(s) — UPSTREAM BUG REPRODUCED:
  [gt4-step-7] sourceLen=203 noopReason="supertex daemon round-done with no
    shipout events (no usable rollback target for this edit)"
  [gt4-step-8] sourceLen=221 noopReason="…"
  [gt5-sub-1]  sourceLen=222 noopReason="…"
  [gt5-sub-2]  sourceLen=243 noopReason="…"
  [gt5-sub-3]  sourceLen=244 noopReason="…"
```

i.e. five consecutive `recompile` rounds finish `round-done`
with zero `[N.out]` shipout events. The transition point is
clean: rounds 1–6 each emit `shipout n=1` + `round-done`, then
from step 7 onward (Hello, world! line ≈155 chars) the daemon
silently no-ops every subsequent edit including the GT-5
`\section{...}` insertion.

The exact upstream-daemon trace from the run (visible in the
`[supertex-daemon event]` lines piped from
`SupertexDaemonCompiler`'s forwardStderr):

```
edit detected at …main.tex:54
rollback k=0
shipout n=1
round-done
…
edit detected at …main.tex:168
rollback k=0
round-done             ← no shipout, gt4-step-7
edit detected at …main.tex:187
rollback k=0
round-done             ← no shipout, gt4-step-8
edit detected at …main.tex:206
rollback k=0
round-done             ← no shipout, gt5-sub-1
edit detected at …main.tex:208
rollback k=0
round-done             ← no shipout, gt5-sub-2
edit detected at …main.tex:228
rollback k=0
round-done             ← no shipout, gt5-sub-3
```

`rollback k=0` on every round (consistent with the live
diagnostic the iter-228 seam captured), then `round-done` with
no `shipout n=…` between them once the body text outruns the
last cached checkpoint. The hypothesis from iter 229 is now
locked locally with no live deploy / Fly Machine / Playwright
dependency.

## Engagement

- Agreed: the bug is upstream supertex, same family as the
  iters 755–758 GT-8 fix but a different input shape. The
  `noopReason` + `rollback k=0` + `round-done` signature is
  exactly what 188_answer.md described and the iter-228/229
  app-log seam confirmed live.
- The local repro shows the bug is **not specific to the warm
  Fly Machine, R2 hydration, or sidecar coalescer** — driving
  `supertex --daemon` stdin directly with the corresponding
  source-revision sequence reproduces it. So the upstream fix
  has a self-contained reproducer outside this repo (port the
  fixture into `vendor/supertex/tests/`).
- The repro is fast (~30s) and deterministic. It will turn
  GREEN the moment upstream supertex starts emitting ≥1
  shipout per successful `recompile` round (whether by
  re-using the prior PDF when no rollback target is usable,
  or by falling back to a cold rebuild). It will stay GREEN as
  the regression lock.

## Why test FAIL is the expected current state

Per question §"Then self-terminate", the failing local test is
the artifact this iteration was asked to produce. `tests_gold/`
is now expected to fail on `test_supertex_warm_doc_body_edit_noop`
(in addition to the existing live GT-5 failure) until the
upstream supertex fix lands. Both failures share root cause; the
new test eliminates the live-deploy dependency for further
diagnosis.

## Halt protocol

Per question §"Then self-terminate":

1. ✓ Failing test committed (the harness will commit at end of
   iteration).
2. ✓ Creating `.autodev/finished.md` with the upstream-blocker
   header.

The human takes the upstream supertex fix from here.
