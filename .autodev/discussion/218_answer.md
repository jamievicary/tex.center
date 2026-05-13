## Correction acknowledged

You're right — I over-interpreted the `supertex: edit detected at …/main.tex:NN`
lines on stderr. Re-reading iter 217's transcript with your clarification in
mind, those lines appeared **only after** I sent `recompile,T\n` on stdin, not
spontaneously. The same is true in iter 218's pure-watcher probe: the single
`edit detected` line I saw "after all 10 writes" actually came out only after
the subsequent liveness `recompile,1` was issued — the daemon checks input
files to pick its resume checkpoint as part of round handling, and that's
when it reports what changed since the last round. There is no asynchronous
file-watcher reacting to disk writes mid-event-loop.

The iter-218 "new stderr marker" — `supertex: watching (daemon mode; stdin
event-loop)` — fits the corrected picture too: "watching" there refers to
*stdin* event-loop, not an inotify-style filesystem watch. I misread the
phrasing.

**Operational consequence.** The iter-215 claim in `214_answer.md` —
"`supertex --daemon` is stdin-driven only, does not auto-reload on disk
edits" — stands. The iter-213-era write/recompile race hypothesis is
therefore *not* re-opened: the only way the daemon can be told to start a
round is the sidecar sending `recompile,T\n`, so the GT-7 trigger must
involve either the *sequence of stdin commands* the sidecar issues, or
state inside the daemon accumulated across rounds, or something at the
sidecar↔daemon framing layer (stdin/stdout/control-frame). It is **not**
a disk-write race the daemon observes independently.

The empirical results from iter 218 are still valid (rapid rewrites and
write-then-immediate-recompile sequences don't crash), but the framing
in the iter-217 log and the iter-218 "watcher re-entry" hypothesis was
predicated on a wrong mental model.

## What I'll change

1. **PLAN.md M9.editor-ux.regress.gt7 entry** — strike the file-watcher
   narrative; restate the stdin-driven-only invariant; preserve the
   empirical iter-217/218 negatives as "these stdin sequences are benign"
   rather than "these watcher behaviours are benign".
2. **Next probe re-ranking.** Demote watcher-related candidates; promote
   (a) sidecar-side audit of `compileCoalescer.ts` + `runCompile` for any
   path that issues a second `recompile,T` before the previous round-done,
   and (b) the original "real-browser paste-`\newpage`" repro.
3. **No code changes this iteration** — this is a model correction. The
   two probe gold cases (`test_supertex_oversize_target`,
   `test_supertex_filewatcher_race`) stay in the tree as regression locks
   on stdin-side tolerance; their docstrings still describe what they
   actually exercise (sequences of stdin commands paired with disk
   writes), which is correct under the corrected model — only the
   *hypothesis they were testing* was wrong.

Will update PLAN.md in this iteration and queue the sidecar audit /
browser repro as the next ordinary iteration's goal.
