# Re: GT-7 was added without a reproducing smoke test

You are right on all three counts. Adding a "pinning" gold test
that passes the first time it runs is worse than worthless: it
encodes the *absence* of a phenomenon I never demonstrated, then
locks that absence in as the green baseline. If the bug later
surfaces, the test catches it by coincidence; if my repro recipe
in the test is wrong (and the live result shows it is), the test
will stay green forever while users keep hitting the crash. The
discipline I should have followed is the obvious TDD inversion:
build the test, run it, **watch it fail in exactly the way the
user reported**, and only then commit it as a pin.

I will not commit another GT-7-shaped pin until I have produced
the red toast myself and seen the test catch it.

## What was wrong with GT-7 as written

1. **No demonstrated repro.** I extrapolated from the iter-213
   user trace (`protocol violation: child exited (code=134)`) and
   wrote a spec whose typing pattern I *hoped* would trigger it.
   The live gold run in iter 215 shows it passes — which means my
   repro recipe is wrong, not that the bug is fixed. I treated
   "looks similar to GT-D" as evidence. It isn't.
2. **`delay: 0` is not realistic typing.** Playwright's
   `keyboard.type(..., { delay: 0 })` serialises keypresses
   through the page event loop with no inter-key sleep, so the
   keystrokes arrive at CodeMirror packed tighter than any real
   user could produce — but more importantly, they arrive
   *before* the WS round-trip for the previous keystroke's Yjs
   update has completed, so the front- and back-end timing on
   the wire is wholly artificial. Real users type with O(50–150
   ms) gaps that give doc-updates time to ship, the coalescer
   time to fire, and the daemon time to start a round before the
   next batch lands. The crash apparently lives in that timing
   regime, not in the pathological 0 ms one. I'd guess
   `delay: 30` to `delay: 80` is the realistic window; GT-D
   already uses 30 ms and is green, so the bug is not pure
   typing-speed either — see point 3.
3. **`\newpage` is the missing variable.** The user's
   reproduction involves *pasting* lines like `\newpage X` — i.e.
   each operation inserts a chunk that bumps the page count by
   one, and the bug surfaces when the page count is swelling
   rapidly across many compile rounds. That's a strong hint the
   crash is page-count-dependent, not keystroke-rate-dependent.
   Candidates I now believe more than the "coalescer overlap"
   theory:
     - **supertex incremental-engine assert on large page-count
       deltas between checkpoints.** A round where the
       checkpoint-resume target page is far from the most recent
       one — because intervening edits added many pages — could
       hit an unhandled state in supertex's incremental
       page-resume code path. SIGABRT (code 134) shape fits.
     - **PDF wire-format frame ordering / segment count.** If the
       sidecar emits per-page segments and a round's output is
       e.g. 12 pages where the previous was 2, a sidecar
       assumption about contiguous page numbering or chunk
       indices could fire (less likely; the sidecar isn't where
       the SIGABRT comes from).
     - **Compile target T choice.** The sidecar sends
       `recompile,T\n` where T is "the page the cursor is on".
       If T is *past* the current page count (because the user
       just pasted `\newpage`s that grow the document but the
       client-side page count hasn't caught up), supertex may
       receive a T it cannot satisfy and the assert lives there.
       This one's testable in isolation by sending
       `recompile,T\n` for an oversize T to a daemon driving a
       short document and watching for SIGABRT.

I think the third hypothesis is the strongest because it ties
the trigger (`\newpage X` paste) directly to a parameter the
sidecar actually controls (`T`). It's also the cleanest to probe
in a `tests_gold/test_supertex_daemon_real.py`-style unit test
that drives `supertex --daemon` directly with no Playwright at
all.

## What I will do next iteration

A two-part TDD plan, in this order, no shortcuts:

1. **Reproduce manually.** Open the live site in a real browser,
   open a project, paste a block of `\newpage X` lines (10 or
   20), watch for the red toast. Capture: the typed/pasted
   content, the cursor position when the crash hits, the
   resulting page count at the moment of crash, and the full
   control-frame trace from the WS (browser devtools network
   tab). Write what I see into `.autodev/logs/<N>.md` verbatim.
   No test code touched yet.
2. **Write the failing test second.** Once I have a concrete
   recipe that produces the crash live, encode that recipe in
   GT-7 (or a replacement spec) and run it against the live
   deploy with the user's data. Confirm it goes red with the
   *same* control-frame contents I saw in step 1. Only then is
   it a pin.

If step 1 fails to reproduce — i.e. the user's crash needs some
condition I can't recreate — I will say so plainly in the log
and ask before committing more speculative test code. The
existing GT-7 stays in the tree as-is until step 2 either
replaces it or deletes it; I won't touch it on speculation.

## Concrete revisions

- **PLAN.md M9.editor-ux.regress.gt7 entry rewritten** to drop
  the current GT-7 as "the pin" and stage the
  manual-repro-first / failing-test-second sequence above.
  Coalescer non-overlap unit test demoted to a follow-up — it's
  still worth doing for confidence but it isn't the next probe.
- **No code changes this iteration.** Discussion mode; the
  actual work is the manual repro, which is a full coherent
  iteration on its own.
- **GT-7 left in place.** Deleting a passing spec that *might*
  catch some variant of the bug is worse than keeping it; it
  costs ~10s on the live runner and the assertion shape is
  correct even if the input recipe is wrong. The replacement
  spec from step 2 will either supersede or augment it.

## On the broader lesson

The same failure mode could surface in GT-6 (`fast content
appearance`) — that test was added iter 214 alongside GT-7 with
no demonstrated repro of the "60s to appear" issue. Iter 215's
live run shows GT-6 green too. Same critique applies: I encoded
an expected-RED test without first watching it go red. I'll
extend the same "reproduce-then-pin" discipline there before
treating GT-6 as a meaningful TDD pin for the underlying issue.
