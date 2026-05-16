# Answer to 365 — budget bump landed; +1 lookahead declined on architectural grounds

## Item 1 — `verifyLiveGt6LiveEditableState` (suspended) budget

**Agree on the diagnosis; partial bump landed.**

The iter-362 single sample is `cmContentReadyMs=1349`,
`keystrokeAckMs=9`. The two budgets do **not** share a wall-clock
— `keystrokeAckMs` is measured from `keystrokeSentAt` (after
`.cm-content` ready), not from click — so the conditional in the
question ("apply the same bump … if both gate on the same
wall-clock") does not apply. The keystroke ack at 9 ms is 100× under
its 1000 ms budget; bumping it would just hide a future regression.

Concrete change this iteration (helper at
`tests_gold/playwright/fixtures/coldFromInactiveLiveEditableTest.ts`):

- Parameterise the per-spec `.cm-content` budget via a new
  `cmContentBudgetMs` field on `ColdFromInactiveOptions`, defaulted
  on the call sites (not in the helper) so the two variants carry
  different numbers visibly.
- Suspended (`verifyLiveGt6LiveEditableState.spec.ts`): pass
  `cmContentBudgetMs: 2500`. Rationale recorded inline: 1349 ms
  empirical (one sample, iter 362) + ~85 % headroom for the spread
  not yet observed. The number is conservative because we have
  exactly one sample; a future iteration with two or three more
  passes should re-tune (likely tighter, possibly looser).
- Stopped (`verifyLiveGt6LiveEditableStateStopped.spec.ts`):
  **left at 1000 ms** for now. Per the question, audit on this
  variant waits until its diagnostic line actually fires — iter 362
  bumped the outer to 120 s, so the next gold pass should produce
  the first stopped-path breakdown. Bumping its inner budget on
  zero samples would hide whatever the cold-from-stopped flow is
  actually doing.
- `KEYSTROKE_ACK_BUDGET_MS` stays 1000 ms in the helper; observed
  9 ms confirms the value.

PLAN priority #1 routing already covered the architectural branches.
The budget bump does not close M13.2(b).4 — that is still gated on
the stopped variant's first diagnostic landing.

## Item 2 — Multipage prefetch `+1` lookahead

**Disagree with the proposed fix. Grounds: it would not change
what the daemon ships per compile.**

The question's mechanism description does not match the current
sidecar code:

1. `apps/sidecar/src/server.ts:611` hardcodes `targetPage: 0` on
   every `compile()` call.
2. `apps/sidecar/src/compiler/supertexDaemon.ts:150`:
   `req.targetPage > 0 ? String(req.targetPage) : "end"` →
   `targetPage: 0` always writes literal `recompile,end\n` to the
   daemon stdin.
3. The `maxViewingPage(p)` helper at `server.ts:453` is consulted
   **only** by `coalescer.kickForView(maxViewingPage(p))` at
   `server.ts:838` — i.e. it is a re-kick gate, not a per-compile
   target.
4. `CompileCoalescer.kickForView` (compileCoalescer.ts:93) fires a
   fresh `kick()` only when `maxViewingPage >
   highestEmittedShipoutPage`. The compile that kick eventually
   runs *still* sends `targetPage: 0` → `recompile,end`.

So the wire `viewing-page` signal does **not** propagate to the
daemon. The +1 lookahead would only force `kickForView` to fire
one extra recompile whose daemon command is identical
(`recompile,end`) to the one that just shipped. If the bug is
"`,end` ships only page 1", an extra `,end` round will ship only
page 1 again. The lookahead is a no-op for the described failure.

Two further checks:

- `verifyLivePdfMultiPageSeeded.spec.ts` (seeded 2-page
  `\\documentclass{article}` + `\\newpage`) **passes** on every
  gold run since iter 333, including iter 362 (line 213 of the
  iter-362 transcript: ✓). That is the cleanest possible no-edit
  multi-page bootstrap and it works. Multi-page rendering on first
  load is not generically broken.
- `verifyLivePdfMultiPage.spec.ts` static and edit-`\\newpage`
  cases also pass on iter 362 (lines 211-212).

The user-reported repro therefore has a specific trigger not
covered by the two-page-`\\newpage` seeds — exactly the M15 Step D'
post-iter-285 finding, restated at `.autodev/PLAN.md` priority #5
(M21.3c) and at `.autodev/discussion/284_answer.md`. The right
next move is the one PLAN already names: capture sidecar
`daemon-stdin` + `daemon-round-done` transcripts of the reproducer
and route per the existing decision tree:

- `daemon-stdin` shows non-`end` `target` ⇒ FE off-by-one (only
  possible if some path bypasses the `server.ts:611` hardcode).
- `daemon-round-done` shows `maxShipout=-1` on a round that should
  have shipped multiple pages ⇒ upstream supertex repro.

Defensive `+1` is not free — it permanently shifts the
`viewing-page` wire signal away from the literal "what the user
can see" semantics that `pickMaxVisible`'s 0.1-ratio threshold was
chosen to express (and that the iter-309 off-by-one fix
specifically restored). Two consequences:

- Anything else that consumes `c.viewingPage` server-side (today:
  only `maxViewingPage(p)` → `kickForView`, but the field is
  durable on `ProjectClient`) starts seeing a value one higher
  than reality. Future code that asks "is the user looking at
  page N?" gets the wrong answer.
- The iter-309 / M21.3a fix forbade promotion of `maxViewingPage`
  on a sub-10% sliver because the user wasn't actually looking
  there. Sending `maxVisible + 1` is the same off-by-one in
  disguise: we now claim the user is looking at a page that may
  not even exist yet.

If we ever did want a "prefetch one page beyond visible" knob, the
right shape is a separate `prefetchPage` field on the wire (or a
sidecar-side `+1` in `maxViewingPage(p)` when the daemon-driven
shipout signal lands), not a re-purposing of the `viewing-page`
signal.

**Action.** No FE / sidecar code change this iteration on item 2.
PLAN priority #5 (M21.3c) is the live route; it is awaiting a
user-supplied repro source per the M15 / 285 conclusion, then a
single targeted gold pass to capture the daemon transcript. The
1-line FE change is straightforward to land **once we have
evidence that `target` shipping is the actual lever** — until then
it is speculative, asymmetric with the iter-309 invariant, and
ineffective against the most likely root cause (upstream `,end`
semantics or trigger-specific compile content).

## Summary

- Suspended budget: bumped to 2500 ms with one-sample rationale.
- Stopped budget: untouched until its diagnostic fires.
- Keystroke ack: untouched (9 ms observed).
- Multipage +1: declined; not a fix for the described mechanism;
  M21.3c stays the right route, waiting on a repro source.
