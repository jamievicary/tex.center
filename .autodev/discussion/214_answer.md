# Re: supertex --daemon mode does not auto-reload on disk edits

You are right; I was wrong. The iter-213 answer's claim that the
upstream daemon's "auto-reload-on-edit fires when the source file
mutates on disk, independent of our compile gate" does not apply
in `--daemon` mode. `supertex --daemon DIR SRC` is stdin-driven:
it does nothing until it receives `recompile,T\n` on stdin, runs
one round, prints `[round-done]`, and waits again. Disk edits of
`SRC` between rounds are not observed and not acted on. tex.center
always runs supertex via `SIDECAR_COMPILER=supertex-daemon`
(`apps/sidecar/src/server.ts:634`), so the disk-watch path simply
isn't in play. The disk-watch behaviour I was thinking of belongs
to the unrelated `--watch` mode that supertex has used in earlier
demos. My hypothesis for the GT-7 daemon crash (unbatched
doc-update writes racing the in-flight round) was therefore
diagnostically wrong.

## What the current sidecar already does

The relevant invariant — *the on-disk `main.tex` is not mutated
while a round is in flight* — is already structurally satisfied:

- The only place that writes `main.tex` is `runCompile()` in
  `apps/sidecar/src/server.ts:323`, line 334:
  `await p.workspace.writeMain(source)`.
- `runCompile` is the `run` callback of the per-project
  `CompileCoalescer` (`apps/sidecar/src/compileCoalescer.ts`).
  The coalescer's state machine guarantees `run` is never invoked
  overlappingly (`inFlight` guard, `maybeFire` early-returns if
  `inFlight`).
- Yjs `doc.on("update", …)` does **not** write to disk. It only
  calls `coalescer.kick()` (server.ts:506), which sets the
  `pending` flag and arms the debounce timer. Doc-updates during
  an in-flight compile are absorbed by `pending`; the next write
  happens at the *start* of the next coalesced round, after
  `round-done` for the previous one has been seen.
- Within one round, the order is: `writeMain(source)` →
  `recompile,T\n` → wait for `round-done` → read chunk files.
  No second writer of `main.tex` exists in the codebase
  (`grep writeMain apps/sidecar/src`: one definition, one
  caller).

So the "extract state from the Yjs blob only when necessary for
the recompile" pattern is already what's implemented. The
Y.Text → string read (`p.text.toString()` on server.ts:329) and
the disk write happen exactly once per coalesced compile, both
inside the coalescer's run callback. There is no separate
caching layer needed — `Y.Text` itself *is* the live state, and
the disk file is a derived view materialised at round start.

The only refinement I'd consider is purely defensive: have
`SupertexDaemonCompiler.compile()` accept the source bytes
directly and do the disk write itself, instead of relying on
the server to write before calling. That would put the
"writes only between rounds" invariant in the same class as
the `recompile,T\n` write, which is already the daemon's
responsibility. It's a tidiness improvement, not a fix — the
current shape is correct.

## So what is GT-7 actually pinning?

If disk-write races are off the table, the live red toast
(`protocol violation: child exited (code=134)`) on rapid typing
must come from one of:

1. **A real bug in `supertex --daemon` on some input pattern**
   produced by zero-delay typing into the seeded template.
   SIGABRT (code 134 = 128+6) is consistent with a C/C++ assert
   firing inside the incremental engine when a particular edit
   sequence hits an unhandled state. This would be an upstream
   blocker once isolated to a minimal `.tex` repro.
2. **Coalescer state bug** that *does* allow two `recompile,T`
   writes back-to-back without an intervening `round-done`. I've
   re-read `compileCoalescer.ts`; the state machine looks tight
   (`inFlight` blocks `maybeFire`, the `finally` re-arms only via
   the debounce timer, `run` is the only call site). But the
   protocol-violation message is exactly what
   `SupertexDaemonCompiler` emits when its own `busy` re-entry
   guard trips (`supertexDaemon.ts:100-103`), so if the coalescer
   ever did double-fire, this is the shape we'd see. Worth a
   targeted unit test that drives `CompileCoalescer` with a
   slow `run` and a high-frequency `kick()`, asserting `run` is
   called sequentially with no overlap.
3. **A round actually timing out and a *new* coalesced round
   firing before the dying child has finished crashing.** The
   round timeout is 60 s. If the child SIGABRTs mid-round, the
   `exit` handler fires `failPendingWaiter` with a violation
   event (`supertexDaemon.ts:233-238`), so the in-flight compile
   resolves promptly — but if the iter-213 dead-child detection
   doesn't trigger correctly in some path, we'd see the second
   `compile()` either hang or hit the `busy` guard.

Best next probe: a sidecar-side unit test (not gold) that
hammers a `CompileCoalescer` driving a fake `Compiler` whose
`compile()` records every entry, asserting strict non-overlap
under N concurrent `kick()` callers at 0 ms intervals. If that
passes, the coalescer is exonerated and the focus shifts to the
upstream daemon. Either outcome is informative.

## Concrete revisions

- **Iter 213 answer's diagnosis section is partially wrong.** The
  "supertex's auto-edit-detection re-enters mid-round" line is
  not applicable in `--daemon` mode. The earlier suggestion to
  "gate disk writes behind the coalescer" is moot — they already
  are. Leaving 213_answer.md as-is per the never-edit-discussion
  rule; this file supersedes it on the daemon-protocol point.
- **PLAN.md updated:** M9.editor-ux.regress.gt7's fix-probe
  paragraph is rewritten to drop the auto-reload theory and
  schedule the coalescer-non-overlap unit test as the next
  diagnostic.
- **No code changes this iteration.** Question was diagnostic;
  the corresponding code change is the unit test, which is a
  full coherent slice for the next ordinary iteration.

## Why no caching layer is needed

Restating: the architecture you describe — "state is extracted
from the Yjs blob only when necessary for the recompile" — is
the current architecture. Y.Text is the authoritative store,
read once per round inside the coalesced runCompile, written to
disk once per round, then `recompile,T\n` is sent and the round
completes before any further write can happen. Adding a
between-rounds string cache of `p.text.toString()` would be
strictly worse: it'd be a stale copy of an already-cheap O(N)
read, and the moment Yjs sees an update during the round you'd
either invalidate the cache (no win) or serve stale bytes on the
next round (a bug).
