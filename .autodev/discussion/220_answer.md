# Live-log diagnosis — root cause identified (not a daemon crash)

You were right that I should look harder. I did, and the live logs show
the smoking gun. **Your "red error toast" is *not* a supertex daemon
crash.** It is the sidecar's per-project compile coalescer failing to
hold off overlapping `runCompile()` invocations during a slow first
compile, producing 5+ `compile-status state:"error" detail:"supertex-daemon:
another compile already in flight"` frames in rapid succession — each
rendered as a red toast.

## Evidence — full transcript from machine `d892d45be33608` (project `00000000-…-0001`, GT-7 cold-start)

```
13:31:47.202  sourceLen:70  msg:"compile start"        ← run #1, seeded text
13:31:47.415  sourceLen:16  msg:"compile start"        ← run #2 fires while #1 is in flight
13:31:47.422  elapsedMs:7   error:"…already in flight" msg:"compile error"
13:31:47.518  sourceLen:31  msg:"compile start"
13:31:47.520  elapsedMs:2   error:"…already in flight" msg:"compile error"
13:31:47.620  sourceLen:45  msg:"compile start"
13:31:47.622  elapsedMs:3   error:"…already in flight" msg:"compile error"
13:31:47.723  sourceLen:60  msg:"compile start"
13:31:47.726  elapsedMs:3   error:"…already in flight" msg:"compile error"
13:31:47.830  sourceLen:76  msg:"compile start"
13:31:47.831  elapsedMs:1   error:"…already in flight" msg:"compile error"
13:31:47.937  sourceLen:76  msg:"compile start"
13:31:47.938  elapsedMs:1   error:"…already in flight" msg:"compile error"
13:31:51.457  elapsedMs:4255 segments:1 bytesShipped:56540  msg:"compile ok"  ← run #1 finally completes
```

Six `compile-status state:"error"` control frames went out to the
client during run-#1's 4 .25 s cold-start window. Each one is a red toast
in the UI. The first one is the daemon process spinning up
`lualatex` for the first time (`ensureReady` + initial compile). The
others are all `runCompile()` invocations that *should never have run* —
the coalescer's `inFlight` gate should have collapsed them into one
queued follow-up, exactly the way `serverCompileCoalescer.test.mjs`
case 1 verifies.

That is the same shape your local repro produces. After ~15 added
`\newpage XX` lines (or any sequence whose doc-updates straddle a
cold-start), the 4-second first-compile window soaks up several
debounce ticks (`COMPILE_DEBOUNCE_MS = 100`) and the second-and-later
ticks each fire `runCompile()` → `SupertexDaemonCompiler.compile()` →
`busy=true` → `another compile already in flight`. Hence "after ~15
instances, red toast" is correct as a *timing* description but the
true variable is **cold-start duration × debounce period**, not page
count.

## Where the prior diagnosis went wrong

The GT-7 spec (`verifyLiveGt7RapidTypingDaemonStable.spec.ts`) asserts
*no* control frame contains `protocol violation` / `child exited` /
`stdin not writable`. It does **not** assert anything about
`already in flight`. That is why GT-7 is GREEN in the latest gold
runs and we kept missing the real bug. The phrasing in
`213_answer.md` and the iter-215..219 narrative locked onto "the
daemon is dying" and never went back to "maybe the
*sidecar-emitted* error frame is what the user sees" — even though
that's the simpler, smaller explanation.

`tests_gold/lib/test/supertexOversizeTarget.test.mjs` and
`tests_gold/lib/test/supertexFilewatcherRace.test.mjs` were both
written to probe a *daemon-side* bug. They drive the daemon directly
and bypass the coalescer entirely, so they would never see this
failure mode. They are both still valid as upstream-tolerance
regression locks but they cannot pin the GT-7 user bug.

## Open question — why does the coalescer's gate fail?

The coalescer (`apps/sidecar/src/compileCoalescer.ts`) sets
`this.inFlight = true` synchronously *before* invoking `run()`, and
the `.finally` on `run()` resets it only after the returned promise
settles. The unit test `serverCompileCoalescer.test.mjs` case 1
verifies a burst of 50 updates during an in-flight `ManualCompiler`
call collapses into exactly one follow-up. So the failure mode in
production must involve some interaction that the `ManualCompiler`
mock doesn't reproduce. Candidates I have not yet eliminated:

1. **Hydration timing.** `runCompile` awaits
   `p.persistence.awaitHydrated()` and `ensureRestored(p)` *after* the
   coalescer set `inFlight = true`. The "compile start" log fires only
   when those awaits resolve. If `runCompile` were being entered from
   somewhere other than `coalescer.run` — e.g. directly — `inFlight`
   would still be from a previous run. **But `grep` only finds the one
   call site at server.ts:257.** So this only explains the failure
   if something resets `inFlight` early.
2. **An exception in `run()` that the `.finally` swallows.** If
   `runCompile` synchronously threw (before the first `await`), the
   `.finally` would fire immediately and reset `inFlight` to false.
   Nothing in the body looks synchronously throwable on the happy
   path, but worth a deterministic local probe.
3. **A second coalescer instance.** Only one `new CompileCoalescer`
   site exists, and `getProject` is idempotent under single-threaded
   JS — so a *new* coalescer per WS connection isn't plausible.
   Listed only to record what was ruled out.

## What I'm doing about it

1. **Next iteration's goal: a deterministic local reproducer.** Drive
   the full sidecar (not the daemon in isolation) with the real
   `SupertexDaemonCompiler` and a sequence that matches your repro —
   bootstrap a project, fire one Y.Text doc-update, immediately fire
   N more spaced ~100 ms apart, and assert no
   `compile-status state:"error"` frames containing
   `already in flight` are broadcast to the client. The slow first
   compile is the load-bearing factor; the supertex binary is
   available in CI so this can be a `tests_gold/` case (skipped when
   the binary is absent, same as the existing supertex probes).
2. **Fix.** Once the reproducer goes RED, find the actual coalescer
   defect, fix it, and add the assertion to GT-7 as well
   (`compile-status state:error` containing `already in flight` is
   never tolerated). Both should land in one coherent slice.
3. **Plan update.** I'll rewrite the M9.editor-ux.regress.gt7 entry
   to point at the coalescer, drop the "supertex daemon crash"
   framing, and demote the upstream-tolerance probes to "kept as
   regression locks".

## Yes I can read live logs

`flyctl logs -a tex-center-sidecar -i <machine-id> --no-tail` returns
the last ~100 lines per machine — enough to catch a recent session
but not historical. The token in `creds/fly.token` works. I should
have done this *much* earlier; instead I spent five iterations
probing the wrong layer. Lesson recorded.
