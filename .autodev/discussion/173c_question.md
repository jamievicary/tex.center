# PLAN.md is stale — lift FREEZE, rewrite, resume plan-review cron

Three observations from the user, all true:

1. **PLAN.md is 588 lines, but length isn't the symptom.** Most
   of those lines are accreted past-iter narratives that belong
   in the iter logs, not a forward-looking plan. The size matters
   only insofar as it makes the live forward path unfindable.
   The cause is that…
2. **the `N % 10 == 1` plan-review cron is frozen by the FREEZE
   block** at the top of PLAN. It hasn't run since iter 147.
   Without it, every iter's narrative lands and stays.
3. **The FREEZE is itself stale.** Its criterion was: *"Until
   `verifyLiveFullPipeline.spec.ts` (M8.pw.4) runs green
   automatically on every deploy, no other engineering work
   proceeds."* Iter 169 declared M8.pw.4 ran green for the first
   time; iter 170 confirmed. **The criterion was met more than 20
   iters ago.** The FREEZE should have been lifted at iter 170. It
   wasn't.
4. **Iter-prediction milestones are inappropriate.** PLAN's
   CRITICAL PATH section uses "Iter X: …" / "Iter X+1: …" framing.
   Iter numbers depend on what discussion questions land in front;
   you can't predict them. Milestones must be feature-based, not
   iter-numbered.

## What to do this iteration

This is a plan-rewrite iteration. No production code touched.

### 1. Lift the FREEZE

Delete the FREEZE block at the top of PLAN.md. Replace with a
one-line "FREEZE-lift recorded iter N (M8.pw.4 went green in
iter 169)" note in the recent-history section (or just remove
entirely; the iter logs are the actual history). The resumed
items:

- `N%10==0` refactor cron — back on.
- `N%10==1` plan-review cron — back on. **The very next time it
  fires is the structural rewrite below**, but the cron's normal
  job is keeping PLAN.md trim from now on.
- M7.4.2 / M7.5 follow-up work, FUTURE_IDEAS slices — back on
  scope.

### 2. Rewrite PLAN.md

Three sections. Use line counts as a *soft target* not a hard
constraint — when there are genuinely many open milestones or
known gaps, a longer doc is appropriate. The previous 588-line
state was wrong not because it was long, but because it had
accreted closed-work narratives that belong in the iter logs.
A 200-line forward-looking PLAN with real surface area is fine.

- **§1 Recent state.** What's working live, what's the most
  recent product gap surfaced (with pointer to its discussion
  question if one exists). No iteration numbers beyond pointing
  to discussion files. Aim for ~10 lines; longer if the live
  state genuinely has multiple recent inflection points worth
  capturing.
- **§2 Milestones.** Feature-based, not iter-numbered. Each
  milestone is a one-paragraph block:
  - Name.
  - What it delivers (concrete user-visible capability).
  - Pointer to the load-bearing discussion question(s), e.g.
    `(see discussion/172_question.md, discussion/173b_question.md)`.
  - Status: not started / in progress / done.
  No "Iter X: …" lines anywhere. If you want to record what's
  next, say "next slice" or "next milestone", not a number.
  Length here scales naturally with the active surface area —
  use as much as needed, no more.
- **§3 Open questions / known gaps.** Brief one-liners. Keep
  resolved items out — when something stops being open, move it
  into a milestone or delete it.

Closed milestones collapse to one line: "Completed: M0–M7.5.5,
M8.pw.0–pw.4 (see git log)". History lives in the iter logs,
not in PLAN. The compression discipline matters more than any
specific line target.

### 3. Discussion-question pointers

Every active milestone in §2 should name the discussion
question(s) that scoped it. Examples:

- Compile coalescer → `172_question.md`.
- Resource tracking + Machine cleanup → `173b_question.md`.
- Debug-mode protocol toasts → `174_question.md`.

That gives the next agent (or the human reader) a direct path
from "what we're trying to do" to "the brief that scoped it".

### 4. Resume plan-review cron behaviour

Once this iter completes, plan-review at `N % 10 == 1` resumes
naturally. Its job is to keep PLAN.md under the ~100-line target
each time it fires by collapsing narrative that accreted in the
last 10 iters into the per-milestone blocks.

## On ordering vs the queued questions

Land **after** `173b_question.md` (the Fly resource leak — money
burning right now takes priority over plan hygiene). Land
**before** the actual feature work resumes, so the resumed
iters use the corrected plan as their goal-selection input.
Same reasoning as `147_question.md`: PLAN is the steering
input; fix the steering before turning the wheel.

If the agent judges any of these directives wrong, say so in
the answer and propose an alternative. The principle: **PLAN
should be forward-looking — every line earns its place by
informing the next iteration's goal-selection**. Lines that
just narrate past iters' work belong in the iter logs, not
PLAN. Compression by that test, not by line count.
