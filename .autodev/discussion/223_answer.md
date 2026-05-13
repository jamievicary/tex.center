# Reproduced live, on the first try with a cold project — and the bug is *not* what 220_answer.md said it was

You're right. The meta-failure pattern was real: I kept adding
"pinning" tests against the *shared warmed-up* live project and
they kept passing because the shared project is past cold-start
before any spec runs against it. This iteration I built the spec
your repro requires (fresh project per invocation, cold sidecar
Machine, 500 ms `\newpage XX` cadence) and ran it ad-hoc against
`tex.center` before promoting it to the gold suite.

It reproduced on the very first run. **And the captured frame is
not an `already in flight` coalescer error.** It is a daemon
crash — the exact iter-213 protocol-violation shape, which the
iter-220 narrative had ruled out.

## Captured transcript (iter-224 live, project `0d865ebb-…-c593`)

```
[verifyLiveGt8] project=0d865ebb-...   coldStartMs=20231 framesSent=251
                pdfSegments=5 controlFrames=14 errorFrames=1
control: {"type":"hello","protocol":1}
control: {"type":"file-list","files":["main.tex"]}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"idle"}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"idle"}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"idle"}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"idle"}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"error","detail":
  "supertex-daemon: protocol violation: child exited (code=134 signal=null)
   stderr=supertex: watching (daemon mode; stdin event-loop)
   supertex: daemon ready
   supertex: edit detected at /tmp/.../main.tex:56
   supertex: edit detected at /tmp/.../main.tex:163
   supertex: edit detected at /tmp/.../main.tex:187 ..."}
control: {"type":"compile-status","state":"running"}
control: {"type":"compile-status","state":"idle"}
```

Decoded:

- `code=134` is SIGABRT (128 + 6). The supertex binary aborted
  itself — this isn't `lualatex` blowing up, it's `supertex --daemon`
  hitting a `panic!` / `abort()`.
- Three `edit detected at ...:56`, `:163`, `:187` lines in stderr —
  three successfully-queued `recompile,T` commands processed before
  the abort. Line numbers grow as the document grows (correct;
  `\newpage XX` lines append).
- One `state:"error"` frame, then the daemon respawns and continues
  (the subsequent running/idle pair). So the sidecar's
  `SupertexDaemonCompiler` *does* recover from the crash — the
  surfaced red toast is the single error frame, not a permanent
  outage.

## Where iter-220's diagnosis went wrong, in plain terms

220_answer.md saw a logs line that said `another compile already in
flight` in a *different* failing session (machine `d892d45be33608`)
and concluded the iter-220 user-visible bug must be the same shape.
That conflation was the error. There are two distinct failure modes:

1. **`already in flight`** — a *sidecar*-emitted error frame
   originating in `SupertexDaemonCompiler.compile()`'s `busy` guard,
   which is hit when something bypasses the coalescer or when two
   coalescers exist for one project. This frame *can* appear; it is
   benign in the sense that the daemon survives, but ugly because
   it surfaces as a red toast.
2. **`protocol violation: child exited (code=134)`** — the daemon
   binary itself aborts. This is what 220_question.md's repro
   produces. The coalescer is doing its job; supertex is the
   defective party.

The 213-thread originally diagnosed (2) correctly. 220_answer.md
talked itself into (1) on the basis of one unrelated stderr line,
and iter 221-223 then chased a phantom. I should have insisted on a
live cold-project repro five iterations ago rather than auditing the
coalescer.

## What I did this iteration

- `tests_gold/playwright/verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts`
  — new permanent gold spec. Creates its OWN fresh project per
  invocation (cold Machine), drives the 500ms `\newpage XX` cadence
  during cold-start, captures every control frame, asserts no
  `state:"error"` frame. Tears down the project + Machine in `finally`.
  Gated only on `TEXCENTER_FULL_PIPELINE=1` (same as GT-1..7), so
  every gold run from now on exercises it. The test went **RED**
  on its first live run — the test you asked for.
- The spec replaces the iter-223 framing for the gt7 / coalescer
  failure path. The pre-existing
  `verifyLiveGt7RapidTypingDaemonStable` keeps its scrutiny set
  (protocol violation / child exited / stdin not writable / already in
  flight) — it will catch (1) if it recurs and catch (2) under
  warm-project rapid typing.

## What the next iteration should do

The bug is upstream in `vendor/supertex` (a submodule, but PRs are in
scope per CLAUDE.md). Concrete plan:

1. **Local non-live repro inside `tests_normal/` (or
   `tests_gold/lib/test/`).** The live spec is slow and costly; we
   need a fast reproducer to iterate on the supertex fix. Drive
   `supertex --daemon` directly with the exact stdin sequence we
   observed: send the seeded `Hello, world!` doc, fire 20
   `recompile,T` commands at 500 ms intervals where each `T` is the
   prior text plus one `\newpage NN` line. If supertex aborts with
   code 134, we have a fast lock. (The existing
   `tests_gold/lib/test/supertexFilewatcherRace.test.mjs` framework
   is the place to add this.)
2. **Run supertex under a debugger / sanitizer locally** to identify
   what's panicking. Code 134 + Rust = a panic or `abort_handler`
   firing. Given the "edit detected at ...:56 ...:163 ...:187" trail
   and that this is incremental compilation with checkpoints, my
   bet is on either (a) a corrupted checkpoint state when a resume
   point disappears between recompiles, or (b) a race in the
   filewatcher / stdin event loop. The `edit detected` log line
   appears in the post-`recompile,T` codepath per 218_answer.md, so
   the watcher itself is fine — the failure is in
   resume-from-checkpoint.
3. **Fix in supertex, then drop GT-8 to green.** Open a PR against
   the vendored submodule (this is in scope).

## On the meta-lesson

You said "stop adding pinning tests that already pass". You were
right. The fixed protocol going forward, for *any* user-reported
live-only bug:

1. Build a probe spec that creates a fresh cold project (NOT the
   shared warm fixture) and runs the user's literal procedure.
2. Run it ad-hoc against live. If it does not fail, the spec is
   wrong; iterate on the spec, not the codebase.
3. Only once it fails on live, promote it to a permanent gold spec.
4. Then chase the fix.

Step 1 is now demonstrated in this iteration's spec — the cold
fresh-project path is the load-bearing primitive that the iter
215-223 sequence kept missing.
