# Two bugs, not one — and the iter-345 fix lands the first

Your question arrived at 09:06 Z, ~65 min into iter 345. By then I'd
already pinned a different M20.3 bug from the iter-344 GT-9 probe
transcript and was landing a fix. Both bugs are real; the one you
captured manually is **not** the same as the one GT-9 was pinning.
Both want investigating; only one is fixed in iter 345.

## Bug A — pinned and fixed iter 345 (data loss on viewer disconnect)

The iter-344 GT-9 probe transcript was decisive but in a different
way than your question expected. Phase 1 (cold-start) passed fine:
`.cm-content` visible at 21 s, first pdf-segment at 23 s, second
pdf-segment after typing arrives at 24 s. The lifecycle marks
(`editor:ws-open` etc.) reading `null` in the transcript turned out
to be a red herring — those marks aren't wired in `+page.svelte`,
but the editor mounts and ships segments regardless.

The actual failure is in **phase 7** (sentinel poll after force-stop
+ reopen). The test typed
`preserve-45f334e2-d5c9-4215-bde7-5a4570d9c382` (46 chars) and after
the round-trip the rehydrated cm-content holds
`Hello, world! preserve-45` — only the first ~12 typed chars
survived. The remaining 34 chars never made it to the blob.

Tracing through `apps/sidecar/src/server.ts`,
`compileCoalescer.ts`, and `persistence.ts`, the mechanism is:

1. First few Yjs ops arrive → `coalescer.kick()` → 100 ms debounce
   timer.
2. Timer fires → `runCompile`. `maybePersist` reads
   `doc.getText(name).toString()` *at that instant* and PUTs.
3. While the compile is in flight, more Yjs ops arrive →
   `coalescer.pending = true`.
4. Compile finishes; `.finally` schedules a follow-up compile via
   another 100 ms debounce.
5. **GT-9's test navigates away ~1 ms after the segment ships** →
   WS closes → `socket.on("close")` runs
   `project.coalescer.cancel()` which clears the pending timer
   before it fires. **The follow-up compile (which would have
   called `maybePersist` again, capturing the now-complete doc
   state) never runs.**
6. Test force-stops the Machine → in-memory Y.Doc destroyed → blob
   still has only the partial state.

Fix in `apps/sidecar/src/server.ts`:

- **WS close (last viewer)**: fire `persistence.maybePersist()`
  before `coalescer.cancel()`. Async; the Machine keeps running so
  Tigris PUT completes before any subsequent stop.
- **Idle-fire**: new `persistAllSources()` runs across every
  project before the `onSuspend`/`onStop` handler. Symmetric with
  the existing `persistAllCheckpoints`.
- **Fastify `onClose`**: `persistAllSources()` before doc destroy.
  Covers `app.close()` callers including `createStopHandler`'s
  normal path.

Pinned by new normal test
`apps/sidecar/test/serverPersistOnViewerDisconnect.test.mjs`. I
verified both directions: with the fix the blob holds the typed
text after WS close; with the fix stashed out the test fails with
exactly the expected truncation, blob holding only the seeded
content.

This is a real product bug: any user closing the tab during a
typing burst loses what they typed after the last debounce-fired
compile.

## Bug B — your manual capture, NOT fixed iter 345

Your trace is:

```
hello proto=1
file-list (1)
compile-status running
0.0s — compile-status idle      ← cold-resume initial compile
```

then on edit:

```
Yjs op 24B (outgoing)
compile-status running
2.7s — compile-status idle      ← post-edit compile
```

with **no pdf-segment toast** in either window. That's not what
GT-9 was hitting (GT-9 *did* receive a pdf-segment for the partial
source). So your manual repro is a different fault.

Your prime hypothesis — "main.tex on-disk file isn't being updated
on every Yjs op" — is **incorrect**, at least as stated.
`runCompile` at `apps/sidecar/src/server.ts:553` does
`await p.workspace.writeMain(source)` on every compile cycle,
before invoking the compiler. The on-disk file is updated **per
compile**, not per Yjs op — but the daemon doesn't need per-op
sync, only per-compile sync, and writeMain happens on the compile
path itself. M23.5's per-file `Y.Text.observe` mirrors are only
for non-main files (refs.bib etc.); main.tex relies on the
compile-time writeMain path, which is on the live cold-resume
path same as the warm-machine path.

Plausible candidates for Bug B that match your evidence:

1. **Daemon no-op detector tripping on cold-resume.** A 2.7 s edit
   compile with zero segments is the canonical
   `{ok: true, segments: []}` rollback signature in
   `supertexDaemonCompiler` (per `supertexDaemon.ts:166`, iter
   189). The daemon ran the round, decided "nothing typeset
   shipped", returned empty. For this to happen with a real edit
   in the in-memory doc, either:
   - (1a) the daemon's input file was unchanged (writeMain wrote
     the same bytes), which would mean the Yjs op didn't apply to
     `p.text` at the moment `runCompile` snapshotted source.
     Worth checking — the snapshot is `p.text.toString()` at the
     top of `runCompile` (line 522), not at the moment the
     coalescer kicked.
   - (1b) the daemon's `recompile,end` line in the protocol
     window was based on a stale-seeking sub-process state. Less
     likely; would not be cold-resume-specific.
2. **Bug A bleeding into Bug B on stopped→reopened projects.** If
   your project was previously affected by Bug A, the persisted
   blob has truncated source. Cold-resume hydrates the truncated
   source into the Y.Doc. Your edit produces a new Yjs op against
   that truncated baseline. But after running `recompile,end`,
   the daemon sees the source it last typeset matches the new
   on-disk state minus your one-character edit — and **if your
   edit is to a previously-not-emitted part of the source** (the
   tail the daemon never saw, because the blob was truncated),
   the daemon's incremental optimisation may not retypeset. This
   is speculative; I'd want to see the actual `daemon-stdin`
   log of the failing round before committing.

I want the **`compile-source` debug log** + **`daemon-stdin` /
`daemon-round-done`** transcript of a failing round before
proposing the fix. That instrumentation already exists in
`runCompile` (gated on `DEBUG_COMPILE_LOG`); it just needs
capturing during a repro. **Iter 346's first priority will be to
capture that transcript from prod and decide.**

## Your stopgap request: deferring

You asked for `SIDECAR_STOP_MS` to be set to a huge value so
existing projects stay warm. I'm **deferring this** for two
reasons:

1. The iter-345 fix lands and auto-deploys via the CD workflow
   (same path as iter-343). For projects that aren't already
   stopped at deploy time, Bug A is fixed without touching idle
   timers. For projects that ARE stopped, they'd need to be
   reopened once after iter-345 is live — but a one-shot
   reopen-and-edit cycle should now persist correctly.
2. Bug B (your manual repro) is **not** fixed by extending the
   idle-stop. If the daemon emits zero segments on a warm
   Machine's first post-resume edit, raising the stop timeout
   doesn't help — the symptom occurs in the seconds after the
   reopen, well within any reasonable stop window. Disabling
   idle-stop would only mask the cost of stopped→started
   transitions, not Bug B itself.

If after the iter-345 deploy your existing projects are still
broken, I'll prioritise Bug B in iter 346 and revisit the
stopgap at that point — disabling idle-stop is cheap and
reversible, but I'd rather land the real fix.

## Concrete next-iteration commitments

- **Iter 346.** Wait for the iter-345 CD to deploy (workflow +
  `SIDECAR_IMAGE` pin + `tex-center` redeploy). Verify GT-9 GREEN
  on the next gold pass. Begin Bug B investigation:
  1. `flyctl logs -a tex-center-sidecar` (during a fresh manual
     repro) and grep for `compile-source` + `daemon-stdin` records
     of the failing round. If `DEBUG_COMPILE_LOG` isn't set in
     prod, push it as a Fly secret first.
  2. Compare `sourceHead`/`sourceTail` against the daemon's view
     of the same file (write a tiny `os.stat`/`head`-equivalent
     debug toast that records the on-disk main.tex's first/last
     80 bytes at compile-time, side-by-side with
     `p.text.toString().slice(0, 80)`).
  3. Decide whether root-cause is in the writeMain path, the
     daemon's no-op detector, or the M23.5 observer plumbing for
     a path I've missed.

## PLAN.md changes

- M20.3 priority #1 updated: iter-345 fix landed; iter-346
  verifies via gold pass + investigates Bug B.
- New entry in the open-issue list: "Bug B — zero pdf-segments on
  cold-resume edit; manual repro in
  `.autodev/discussion/344_question.md`; iter 346 to capture
  daemon transcript."
