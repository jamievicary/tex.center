# Fly sidecar Machine leak — answer

## State at iter 174 start

Re-ran `flyctl machine list -a tex-center-sidecar` at the top of
this iteration. **Count is now 2**, both legitimate `app`-tagged
deployment machines (`683437eb1e3378`, `d895e7ea479958`), both
`state=stopped`, image
`tex-center-sidecar:deployment-01KREAMG9HN4GRZK2EF89TSWXT`.

The 27 orphans from the 173b snapshot are gone. I didn't destroy
them this iteration — either Fly auto-pruned (it does for some
machine classes after extended idle), or another path cleaned
between snapshot and now. Either way: **immediate cost is no
longer accruing.** Bug A and Bug B still exist as latent defects;
they will re-leak the next time the affected specs run against
live.

So I'm *not* doing item 1 (orphan cleanup) because there's nothing
to clean. Items 2–4 stand as scheduled engineering work.

## Bug A — agree, broaden the scope

The framing in `verifyLiveFullPipeline.spec.ts` ("idle-stop is
`verifyLiveWsUpgrade`'s job") is wrong as the question notes. It's
also **wrong in five specs, not one**. Grep:

```
verifyLiveFullPipeline.spec.ts:23 // cleanupProjectMachine is intentionally NOT called
verifyLiveFullPipelineReused.spec.ts:23 // (variant: reused-project path; intentionally retained)
verifyLiveEditTriggersFreshPdf.spec.ts:50 // afterEach deletes row only
verifyLiveInitialPdfSeeded.spec.ts:47 // ditto
verifyLiveNoFlashLoad.spec.ts:61 // ditto
verifyLiveSustainedTyping.spec.ts:61 // ditto
```

Each of these creates a per-project Machine, deletes the DB row,
and leaves the Machine running. `verifyLiveFullPipelineReused`
is the deliberate exception (its premise is testing the reused-
project lifecycle) — its Machine *should* persist across runs.
All other five should call `cleanupProjectMachine` in `afterEach`.

**Decision:** next iteration adds `cleanupProjectMachine` to the
four `afterEach` blocks plus the fresh-pipeline spec, and updates
the comments to match. The reused-pipeline spec stays as-is. The
"idle-stop is correctness vs optimisation" framing in the question
is correct and goes into the comment text.

## Bug B — diagnose with logs, then add the regression

Agree with the question's three diagnostic axes (env var set?
viewer-count zero-transition firing? `Compiler.close()`
completing?). The right order, given the cheap-to-expensive
gradient:

1. `flyctl secrets list -a tex-center-sidecar` — is
   `SIDECAR_IDLE_TIMEOUT_MS` set, and to what?
2. `flyctl logs -a tex-center-sidecar` for one of the older
   `started` machines — search for the viewer-count and idle-timer
   log lines from M7.1.4 (or add them if they don't exist).
3. If env + tracker both look right but the timer never fires:
   instrument `Compiler.close()` for slow-close measurement.

The regression spec proposal (open WS, hold 30s, close, wait
12min, assert `stopped`) is sound but 12min of wallclock per run
is brutal. Two refinements:

- Gate behind `TEXCENTER_VERIFY_IDLE_STOP=1` per the question —
  agreed.
- **Lower `SIDECAR_IDLE_TIMEOUT_MS` to 60s for the regression
  spec's project specifically**, via a runtime knob if one exists,
  or a dedicated test-only secret on a separate sidecar app, or a
  per-machine env override. 12-min default in prod, 60-second
  override for the test = ~2 min total wallclock instead of 12.
  If no clean override path exists, fall back to the question's
  12-min variant.

**Decision:** Bug B diagnosis happens in the next-but-one
iteration (after Bug A's spec fix lands, because the spec fix
gates whether we *care* about idle-stop for test cleanup).

## Resource-count guardrail — agree, add now

Item 4 (gold test asserting Machine count below threshold) is
worth landing alongside Bug A's spec fix. Threshold of **5** is
reasonable for current scale (2 app-pool + up to 2 transient per-
project from a live spec run + 1 headroom). Make it configurable
via `TEXCENTER_MAX_SIDECAR_MACHINES` so it can be tuned without
code change.

On failure, the test should list machine IDs + creation timestamps
+ state, so the operator can manually destroy and triage. Use
`creds/fly.token` for the API call.

## Schedule

- **Next iter (175):** Bug A — add `cleanupProjectMachine` to the
  five live spec `afterEach`s, update comments, add resource-count
  gold guardrail.
- **Iter after (176):** Bug B — diagnose idle-stop in prod logs,
  fix whichever link is broken, add gated regression spec.

These two slices replace the previously-pending 175 (no-flash
editor) and 176 (compile coalescer) in the plan — those slide by
two. Per the question's priority framing, money-burning resource
hygiene outranks editor UX.

## On the "money burning" priority claim

It's correct given the snapshot the question was written from (13
machines `started`). With orphans now at zero and idle-stop's
brokenness no longer causing fresh accrual *right now* (no live
spec has run since cleanup), the urgency is lower than the
question assumed. But the spec fix + guardrail still land before
the editor UX work, because the next live spec run will re-create
the leak.
