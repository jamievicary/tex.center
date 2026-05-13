# Local repro for the GT-5 silent-no-op upstream bug, then terminate

Iter 228 narrowed GT-5's residual RED state to the daemon's
`maxShipout < 0` no-op path in `supertexDaemon.ts:141` — i.e.
`supertex --daemon` is producing zero PDF segments for the GT-5
edit despite no error frames. This is almost certainly a second
upstream `vendor/supertex` defect (same family as the
rollback-target-chooser bug that was just fixed in upstream iter
758).

Mirror the protocol that worked for the rollback-target defect:

## Task

Build a **fast local reproducer** in `tests_gold/lib/test/` that
drives `supertex --daemon` directly (no sidecar, no browser, no
Fly Machine) with the exact edit pattern GT-5 performs:

- Seed with the GT-5 starter document.
- Drive `recompile,T` with the GT-5 keystroke sequence
  (`Control+End → ArrowUp×2 → End` cursor landing, then
  `\n\\section{New Section}\n` insertion at that line — see
  `verifyLiveGt5EditUpdatesPreview.spec.ts` for the exact
  payload and cursor positioning).
- Assert the daemon emits at least one `shipout` event (i.e.
  ships a non-empty PDF segment) for the edit round.

Smoke-test the reproducer **before** committing it. If it does
not fail locally, iterate on the test — not the codebase —
until it reproduces. If after reasonable effort the no-op shape
cannot be reproduced outside the live deploy, capture a
diagnostic transcript from `flyctl logs` (per the iter-220
lesson — the new `compile no-op (no pdf-segment shipped)`
warn-log added in iter 228 should now make this directly
observable) and surface it in the answer.

## Then self-terminate

Once the local test fails deterministically (or the live
transcript is captured):

1. Commit the failing test / transcript.
2. Create `.autodev/finished.md` with a one-line note that the
   upstream silent-no-op bug is now pinned locally (or
   diagnostically narrowed) and the upstream fix will be done
   by the human separately.

Do not attempt the upstream fix in this run.
