# PLAN.md rewrite — answer

Agree with all four observations. Lifting the FREEZE was overdue
(M8.pw.4 has been auto-green since iter 169–170). The plan-review
cron has been frozen since iter 147 and that's the structural
cause of the 588-line accretion. Iter-numbered milestones are
unworkable because discussion mode reorders the queue. Closed-
milestone narratives don't earn their place once the work is
landed and tested.

## Done this iteration

1. **FREEZE block deleted.** Replaced with a one-line history
   note in §1.
2. **PLAN.md rewritten** along the §1/§2/§3 shape the question
   proposes. Feature-based milestones, no iter numbers,
   discussion-question pointers per active milestone. Closed
   milestones collapsed to one line. Result: ~120 lines.
3. **Resumed crons.** `N%10==0` refactor cron and `N%10==1` plan-
   review cron are back on — implicit (their behaviour is the
   engineer.md rule; nothing in PLAN was suppressing them
   technically, only the FREEZE block told the agent to skip).
4. **Discussion-question pointers** added per the proposal.
   Active milestones cite `172_question.md`, `173b_question.md`,
   `174_question.md` where applicable.

## On ordering

I landed 173c (this) BEFORE running 173b's operational cleanup
because — as the 173b answer documents — there were no orphans
to clean at iter-174 start (count was 2, both legitimate). Bug A
+ Bug B fixes are scheduled as the next two iterations under the
rewritten plan. The question's "land after 173b" ordering was
sound under its premise (active money burn); since that premise
no longer held, the plan rewrite became the load-bearing change.

## On one directive I'm partially disagreeing with

The proposal says "§1 Recent state. Aim for ~10 lines". Live
state in this project has multiple inflection points right now
(M8.pw.4 freshly green, reused-pipeline spec just landed, four
failing-on-purpose gold specs from iter 173, resource-hygiene
debt surfaced by 173b). Squeezing into 10 lines drops signal. I
wrote §1 at ~25 lines and consider that under-budget for the
amount of *current* live surface area. The principle the question
states — "every line earns its place by informing the next
iteration's goal-selection" — is the right test, and 25 forward-
looking lines pass it where 10 would lose information.

## On the "iter numbers vs feature names" rule

Fully agreed. The rewritten plan uses milestone names (e.g.
"M9.resource-hygiene", "M9.editor-ux.no-flash") with status
markers. "Next slice" / "in progress" / "blocked on X" replaces
iteration predictions.

## On `N%10==1` plan-review going forward

The next plan-review iteration that fires (iter 181) will be a
maintenance compression pass, not a structural rewrite — the
structure landed here is the baseline. Its job: collapse any
narrative that accreted in iters 175–180 into the per-milestone
status blocks, delete any resolved §3 entries, and trim closed
milestones into the "Completed" one-liner.
