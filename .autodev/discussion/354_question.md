# `verifyLiveFullPipelineReused` is RED — primary focus

The live gold spec `verifyLiveFullPipelineReused.spec.ts` has been
failing across recent gold passes (iters 347, 351, 352, 353). This
is a **serious regression**: the spec covers the warm/reused-project
edit→PDF round trip, i.e. the lifecycle a real user hits every time
they open a project they were editing yesterday. Fresh-create
(`verifyLiveFullPipeline`) is GREEN; reused is not. That is exactly
the failure shape iter 162 articulated as the freeze-lift criterion
and it must not be allowed to bed in.

**Treat this as priority #1**, ahead of the current M20.3 /
GT-6-stopped queue. The next iteration's primary objective is to
**root-cause `verifyLiveFullPipelineReused` and land a fix**.

## What to do

1. **Use the instrumentation that already exists.** Don't speculate.
   The iter-352 WS-frame timeline default fixture means every spec
   now emits a compact `[spec-name] frames received:` block to the
   gold transcript (gated on `TEXCENTER_DUMP_WIRE_TIMELINE=1`, on
   by default in the iter-state harness). The iter-347 sidecar
   instrumentation surfaces `replay-segments`, `compile-source`,
   `daemon-stdin`, `daemon-round-done`, and `compile ok` (now with
   `lastSegmentsLen`) on every cycle. **Read the actual transcript
   first** — both the Playwright-side timeline and the prod sidecar
   log slice for the fixed-UUID project
   `00000000-0000-4000-8000-000000000001` covering the spec's
   wallclock window. Decide the failure mode from evidence, not
   from priors.

2. **Classify the failure precisely.** The spec has two assertions
   (a `pdf-segment` frame within 240 s, and a non-blank preview
   canvas). Which one fails? At what wallclock? What was the
   reused project's Machine state at spec start (running /
   stopped / suspended)? Was the Y.Doc Ctrl+A+Backspace clear
   step observed in outgoing frames? Did `compile-status`
   `running → idle` cycles fire with `segments=0`, or did they
   fire at all? Did `pdf-segment` (tag 0x20) frames arrive but
   the preview canvas stayed near-white? Each branch points at a
   different layer.

3. **Cross-reference with Bug B (PLAN priority #2).** The
   "compile runs but emits zero pdf-segments on cold-resume edit"
   user repro is plausibly the same underlying failure surfacing on
   the reused-project gold path. If the iter-347 `replay-segments`
   log line on the reused project shows `lastSegmentsLen=0` at
   WS-connect AND the first compile shipped `segments=0`, this
   spec **is** the synthetic Bug B repro the PLAN was asking for.
   That collapses two priorities into one investigation.

4. **Consider the iter-353 placeholder interaction.** Iter 353 added
   an empty `main.tex` placeholder at `workspace.init()` with
   `flag: 'wx'`. The intent is that prior persisted `main.tex`
   content is preserved on stopped-Machine restart (EEXIST swallow),
   but the reused-project path is exactly where that interaction
   matters. Verify that on a reused-project cold restart, the
   placeholder write does NOT shadow a persisted blob — and verify
   it from the prod log, not from the unit test.

5. **Audit per-project Machine image staleness.** PLAN.md notes
   "may be exacerbated by stale per-project Machine images (iter
   342 audit)". If the reused-project Machine is running an old
   sidecar image (pre iter-345 persist-on-disconnect, pre iter-353
   placeholder), confirm and force a redeploy of that one Machine
   before drawing conclusions about the code path. `flyctl machine
   list -a tex-center-sidecar` + image SHA against current deploy.

6. **Fix and pin.** Once root-caused, land the fix and add a normal-
   suite test (sidecar or web, whichever layer owns the bug) that
   would have failed before the fix. The gold spec on its own is
   not a sufficient lock — gold runs are noisy and slow.

## What NOT to do

- Do not "fix" the spec by widening its timeout or relaxing the
  canvas-painted assertion. Those tolerances are calibrated. If
  the budget is genuinely wrong, that's a separate discussion.
- Do not skip the spec or mark it intermittent. PLAN.md already
  describes it as intermittent; the regression streak across
  iters 347/351/352/353 shows that label is now wrong — it's
  consistently red.
- Do not start by reading more code. **Start by reading the most
  recent transcript** (`tests_gold/state/last_gold_output.txt` or
  the iter-353 log's gold-pass section) and the prod sidecar log
  for the fixed-UUID project over that window.

## Definition of done for the next iteration

Either:
- (a) a landed fix in the appropriate layer, a normal-suite test
  that pins it, and PLAN.md updated to reflect the closure; OR
- (b) if root cause requires an architectural change too big for
  one iteration, a precise written diagnosis (file:line, frame
  timeline excerpt, sidecar log excerpt) plus a concrete next-
  step plan, and `verifyLiveFullPipelineReused` re-prioritised
  to slot #1 of PLAN.md.

A "no fresh evidence available, continued on other work" outcome
is **not acceptable** for this question. If the transcript /
prod log truly does not contain enough signal, the iteration's job
is to land more targeted instrumentation and trigger a fresh repro
within the same iteration via the existing harness re-run path.
