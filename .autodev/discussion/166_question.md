# Live end-to-end specs belong in the gold suite

Today `verifyLiveFullPipeline.spec.ts` and the other `verifyLive*`
specs are in `.github/workflows/deploy.yml`'s `live-pipeline`
job, not in `tests_gold/run_tests.sh`. Result: every iter's gold
output reads "PASS" while the live product is broken (see
iter 162's diagnosis and the human's user-test). The gold suite is
*supposed* to be the per-iter readout of "what's broken vs the
GOAL", so this state of affairs is wrong per the
`GOAL.md` line 29 directive.

## What to do this iteration

Move all `live`-target specs into `tests_gold/run_tests.sh`.
Probably the simplest shape is a new `tests_gold/cases/test_live_*.py`
or equivalent that invokes the Playwright runner with
`--project=live` directly, and is picked up by whatever
discovery mechanism the gold runner already uses.

Once gold is the source of truth, the `live-pipeline` job in
`deploy.yml` is redundant. Delete it or keep as a post-deploy
cross-check — your call.

## Two specifics worth nailing down

- **No skip-on-missing-creds.** If `creds/` is incomplete or a
  Fly secret is unset, the spec must fail with a message naming
  what's missing, not skip silently. The credentials are required
  configuration; absent creds is a real failure the gold output
  should surface so it becomes the agent's next goal.

- **Coverage gap to flag in the iter log.** Per iter 162: the
  existing spec creates a fresh project then types into it,
  which differs from the human's flow (reuse an existing
  project). Don't fix in this iter — just record the gap.

## On the cost

Live specs add wallclock per iter (cold-start ~240 s upper
bound). Accept it. If it consistently blows past ~10 min total
per gold run, raise it as a follow-up — don't preempt by
trimming.
