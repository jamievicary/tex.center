# Answer — accepting the override, rewriting PLAN.md this iteration

## Agreement

The override is correct and I was wrong in 145. Sequencing the
PLAN.md rewrite *after* the live fix assumed iter 145's
diagnostic-and-fix work would land in one contiguous burst.
It won't: there's a probe iter, a fix iter, a verify iter, an
M8.pw.4-activation iter, possibly more. Each one re-reads PLAN.md
to decide what to do. Without a CRITICAL PATH section pinned at
the top, the next ordinary iteration is free to be pulled toward
whatever is most legible in the milestone diary — exactly the
priority inversion that produced iter 140's dead-code refactor
and iter 139's "M7.4.2 next" pointer while save/create/preview
were silently broken in production.

So: PLAN.md rewrite **this** iteration. Live fix in 148+, guided
by the new file.

## What I'm doing this iteration

A full rewrite of `.autodev/PLAN.md` to the shape specified:

1. **CRITICAL PATH** at the top, naming iters 148/149/150 and the
   five user-visible acceptance points (type-saves, create-file,
   PDF-renders, refresh-persists, return-tomorrow-persists).
2. **Per-area current state** in five buckets (Auth / Editor /
   Sidecar / Deployment / Testing), 2–3 lines each, state only,
   no history.
3. **Open questions** at the bottom, single short list.

Plus the non-negotiable: a plain-text block at the very top
saying the live product is broken and that the cron rituals
(N%10 refactor, N%10==1 plan-review) and FUTURE_IDEAS slices are
paused until `verifyLiveFullPipeline.spec.ts` runs green
automatically on every deploy.

Deleting from the old file:

- All closed-milestone narratives (M0–M7.5.5). Replaced by a
  single "Completed: M0–M7.5.5 (see git log)" line.
- "Candidate supertex (upstream) work" section.
- "Live caveats" section (none currently block MVP — the WS
  failure is the blocker, and it's in CRITICAL PATH).
- "Open questions / risks" merged into the new section 3.
- "Current focus" prose (the CRITICAL PATH replaces it).

## On goal-selection prompt edits

You flagged the engineer prompt itself (`autodev/engineer.md`) as
possibly needing surgery if a post-rewrite iteration still picks
off-path. I won't touch it (harness territory). If iter 148
correctly picks the WS probe per the new CRITICAL PATH, the
restructure was sufficient. If it doesn't, that's the signal to
surface in a discussion question.

## Commitments

- This iteration: PLAN.md rewrite, ≤~80 lines, structure per
  spec. No live diagnostics, no fix code.
- Iter 148 (next ordinary): authed WS probe of live, per the
  CRITICAL PATH I'll write into PLAN.md.
- Iter 149+: fix + regression test + redeploy + M8.pw.4
  activation, in whatever order the diagnosis dictates.
- Cron rituals stay paused (pinned at top of PLAN.md) until
  `verifyLiveFullPipeline.spec.ts` is a hard deploy gate.
