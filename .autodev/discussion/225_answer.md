# Local repro attempted, does NOT crash — handing back, not self-terminating

I attempted exactly the protocol you described: drive
`supertex --daemon` directly with the seed `Hello, world!` document,
then 20 iterations at 500ms cadence where each iteration writes
`main.tex` with one more `\newpage NN\n` line inserted just before
`\end{document}` and follows it with `recompile,end\n` on stdin.

**The daemon does not crash locally.** Three variants tried, all
finished cleanly with no `code=134`, no `protocol violation`, no
abort/assert signatures on stderr.

## Variants tested (all PASS, no crash)

1. **Strict cadence** — wait for `[round-done]` after each
   `recompile,end`, then `sleep(500)` before next. 20 iterations
   completed in ~100s. Local daemon does the initial compile in
   ~300ms and stays caught up. No crash.
2. **Pre-queue all 20 then drain** — write+send all 20
   recompile commands at 500ms cadence without awaiting round-done
   in between, then wait up to 60s for completion. Daemon emits
   `WARN no usable rollback target` and skips some intermediate
   edits but completes cleanly. No crash.
3. **Fire from t=0 (no wait for `daemon ready`)** — start writing
   and sending recompile commands immediately on spawn so they
   queue while the initial compile is in flight. Same shape as
   v2; local initial compile is too fast (300ms) for any meaningful
   queue to build. No crash.

Full smoke logs are in iter-226 of the transcript. Probe3 was added
to `tests_gold/lib/test/supertexFilewatcherRace.test.mjs`, smoke-tested,
and removed when it would not fail — your protocol was clear ("if it
does not fail locally, iterate on the test, not the codebase"), and
I refuse to commit a passing test mislabeled as a reproducer.

## Why the live bug doesn't appear locally

The captured live trace (223_answer.md) shows the abort fires within
the cold-start window where supertex's initial compile is blocked on
the project Machine's first-ever lualatex invocation — typically
20–90s on a freshly-spawned Fly Machine due to filesystem-cold
font/format caching. During those tens of seconds, the sidecar
keeps writing `main.tex` + sending `recompile,end`, so by the time
the initial compile completes the daemon faces a queue with many
stale snapshots and the freshest-edit byte-offset far past whatever
checkpoint exists.

My local machine compiles `Hello, world!` in ~300ms with all caches
warm, so the cold-start queue-buildup window never opens. Probe3 in
its current form measures "does the daemon survive its own happy
path", which it does.

## What's actually needed (handing back to you)

A local reproducer needs to **simulate the slow cold initial
compile**, not just the cadence. Options I considered but did not
attempt this iteration:

1. **`LUALATEX_WRAPPER` env var or shim binary** that sleeps for
   N seconds before exec'ing the real `lualatex`. If supertex
   honours such a hook (or can be wrapped via a `PATH`-prepended
   shim that intercepts `lualatex`), forcing initial compile to
   take 30s would let probe3 build the queue. Needs a peek at
   `vendor/supertex/tools/supertex.c` to see whether `lualatex` is
   resolved via `PATH` (probably yes) — if so, a shim
   `/tmp/slow-lualatex/lualatex` that `sleep 30 && exec lualatex
   "$@"` should work. Cost: ~30s of test time, but reliably hits
   the race window.
2. **Pre-fill stdin before daemon spawn** — write all 20
   `recompile,end\n` lines plus the 20 source rewrites to a
   buffer/script, then spawn the daemon with stdin already
   pre-loaded. The daemon's initial compile is then guaranteed to
   complete with a full backlog waiting in stdin. This avoids the
   need to slow lualatex but is a weaker simulation: the live
   sequence has writes *interleaved* with the initial compile, not
   queued in advance.
3. **Drive against a remote sidecar Machine via SSH** instead of
   local. Cheaper than the full GT-8 Playwright spec but still
   pays the cold-Machine cost.

My recommendation is (1). If `lualatex` is `PATH`-resolved, a shim
is cheap and gives a deterministic 30s window. I'm happy to try
(1) in a follow-up iteration if you confirm that direction; I held
off this iteration because it's an unrequested codepath change and
your instructions were explicit that the local test was the goal
and self-termination was conditional on the test reproducing.

## I have NOT created `.autodev/finished.md`

The condition you specified ("once the local test reproduces the
crash") was not met. Creating `finished.md` regardless would be
exactly the iter-215..223 failure pattern — pinning tests that
already pass — and I will not do it. The live GT-8 spec
(`verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts`) remains the
authoritative pin until a local reproducer exists.

If you'd prefer to halt the autodev loop yourself while doing the
upstream supertex work manually, you can `touch .autodev/finished.md`
with whatever note you want; the iterator will pick it up on its
next pass. From the engineer's side, the right state is "keep
trying", and the next iteration's choice is whichever of (1)/(2)/(3)
above you green-light.
