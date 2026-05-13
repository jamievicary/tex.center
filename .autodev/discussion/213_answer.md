# Re: two live-deploy regressions on v213

Agreed on both. Adding the pinning gold tests this iteration; fix
work deferred to follow-up iterations per your "RED before fix"
sequencing.

## 1. Slow `.cm-content` appearance — GT-6 added

New spec: `tests_gold/playwright/verifyLiveGt6FastContentAppearance.spec.ts`.

Asserts: on the warmed-up `liveProject` fixture, navigating to
`/editor/<id>` causes `.cm-content` to contain the `documentclass`
seed-template sentinel within **2000 ms** of `goto` returning.
Bound chosen to be tight enough to catch the reported "up to a
minute" pathology with margin, while leaving headroom for normal
live-deploy variance. The "few hundred ms" stated target is the
aspiration; 2 s is the regression line.

Note on the existing coverage: **GT-A is not redundant.** GT-A
asserts the no-flash invariant (first observed `.cm-content` is
never empty) on a freshly-seeded project with a 10 s budget. GT-6
pins a tight latency bound on a warm project. Different invariants;
GT-6's failure tells us the editor is no longer fetching/binding
its Yjs doc quickly, even when the Machine is hot.

Caveat: GT-A passed on iter 210 and again on iter 213. If GT-6
also passes against live, the regression is on a path GT-6 misses
— most likely the cold-Machine path (warm-up bypassed) or an
idle-stop revival between dashboard view and editor click. In that
case the follow-up is to add a GT-6b that **forces the warm-up
gap**: idle-stop the Machine after `globalSetup`, then click and
re-time. I'll only add that if GT-6 unexpectedly passes — no point
pre-bloating the suite.

## 2. Daemon crash under rapid typing — GT-7 added

New spec: `tests_gold/playwright/verifyLiveGt7RapidTypingDaemonStable.spec.ts`.

Asserts: zero-delay `keyboard.type(RAPID_BODY)` (~570 chars,
serialised through Playwright but no inter-key delay) produces no
control frame whose JSON contains any of
`protocol violation`, `child exited`, or `stdin not writable`.
Those are the three error shapes by which the daemon-death
condition currently surfaces (iter-202 batch + iter-213 follow-on).

Why GT-D doesn't catch this and GT-7 should:

- GT-D uses 30 ms inter-keystroke. That gives the daemon enough
  breathing room that the batching layer's race window doesn't
  open reliably.
- GT-7 uses 0 ms inter-keystroke. With the page event loop still
  serialising the events, this is the tightest the user can
  realistically drive the system — matches your "rapid typing
  reliably produces a red toast" report.
- GT-7's assertion is direct (control-frame text match), not the
  indirect "overlap error" proxy GT-D uses.

## Diagnosis I agree with

> The edit-batching layer is supposed to ensure the daemon only
> sees one clean package of edits at a time… The observed
> multiple back-to-back `edit detected` lines followed by a child
> crash (exit 134) suggests batching is not being respected.

Consistent with the iter-200 coalescer extraction history. The
coalescer gates **compile** rounds (`compile in flight → queue at
most one follow-up`), but the upstream supertex daemon's
auto-reload-on-edit fires when the source file mutates on disk,
independent of our compile gate. If we write source bytes to disk
before/after issuing `recompile,N`, and writes interleave with an
in-flight round, the daemon's own edit-detection re-enters and
exit 134 (SIGABRT) is consistent with an assert-failure in
supertex's incremental engine when re-entered mid-round.

Concrete next-iteration fix probe (not landing this iteration):
trace where the sidecar writes the on-disk `main.tex`. If it
writes on every Yjs doc-update without coordinating with the
coalescer's in-flight gate, that's the bug. The fix is to buffer
disk writes behind the same gate that buffers `recompile,N` lines
— a single batched write per coalesced compile request.

## What landed this iteration

- `tests_gold/playwright/verifyLiveGt6FastContentAppearance.spec.ts`
- `tests_gold/playwright/verifyLiveGt7RapidTypingDaemonStable.spec.ts`

Both expected RED on the next harness gold pass against live. No
fix code in this iteration — preserves your "RED before fix"
sequencing and gives the iter-N+1/N+2 attempts a clean signal.

## Commitments for follow-up iterations

- Iter N+1 (assuming GT-7 turns RED on the next gold pass): trace
  on-disk source-write call sites in the sidecar, identify the
  unbatched path, gate it behind the coalescer. Add a sidecar-unit
  test that drives concurrent doc-updates and asserts a single
  coalesced write per compile round.
- Iter N+2 (assuming GT-6 turns RED): instrument
  `/editor/<id>`'s Yjs hydrate path with M13.1's
  `EDITOR_YJS_HYDRATED` mark + a per-mark debug toast, then
  identify whether the latency is on connect, initial-sync, or
  CodeMirror bind. M13.1 scaffolding is already in
  `editorMarks.ts` per PLAN; this would graduate it from
  scaffold to active.
- If GT-6 unexpectedly passes against warm live, add a GT-6b that
  forces an idle-stop gap between bootstrap and the editor click.

`.autodev/PLAN.md` updated with the new M9.editor-ux slices for
the two regressions; the GT-6/GT-7 RED line items now sit
alongside the existing M7.4.x → GT-5 work.
