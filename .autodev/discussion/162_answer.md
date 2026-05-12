# Live user-flow gaps — answer

Both treated as critical path. Sequenced as you suggested:
diagnose-and-fix #1 first (bug-class), then ship #2 (UX
affordance).

## Correcting one premise before diagnosing

The question reads "`verifyLiveFullPipeline.spec.ts` is
supposedly green" — that's not actually the state on `main`. I
checked the GitHub Actions history:

- Iter 158 wired the `live-pipeline` job into `deploy.yml` —
  first ever automated run of M8.pw.4.
- Iter 158 run: failed at `pnpm install` (tracked-symlink
  `node_modules`).
- Iter 159 run: failed at `pnpm install` (harness `git add -A`
  re-staged the symlink; gitignore was directory-only).
- Iter 160 run: failed at `pnpm install`'s `@types` mkdir (same
  underlying tracked symlink, fixed properly).
- Iter 161 run: in progress at the moment I'm writing this.
  Earliest expected first green-on-`main` is the iter-161 deploy
  (commit `091fb41`) or, more likely, iter 162's (`fa07b06`) once
  iter 161's DB-name default fix is in.

So the spec has **never run green automatically**. The only
empirical evidence the loop closes end-to-end is the iter-157
manual probe (`scripts/probe-live-ws-payload.mjs`). Critically,
that probe verified the **read-only** half of the pipeline:

- `hello` control frame ✓
- `file-list` ✓
- initial Yjs `docUpdateSeen` (loaded state, not a fresh edit) ✓
- sent a `view` control frame (no Yjs edit op) ✓
- held the socket open 3s without upstream close ✓

It does **not** send a Yjs `Y.Text` insert into `main.tex`, does
**not** trigger a recompile, does **not** assert a `pdf-segment`
binary frame arrives. So the "edit → recompile → pdf-segment →
canvas pixels" loop — the exact loop you exercised by typing into
CodeMirror — has never been confirmed live by any probe or spec.
Your user-test is the first observation of that path, and the
result is "no preview". That is consistent: an untested critical
path was broken.

This also means the spec wouldn't have caught your failure even
if it had been green — the spec types a *full document* and waits
for a `pdf-segment`, but until 162 it hadn't gotten to run that
codepath at all. The fact that it's about to start running
(presumably green or red) on iter 162's deploy is what we'll
learn next.

## #1 — PDF preview never renders: diagnostic plan

I am NOT going to bundle the diagnosis into this discussion-mode
iteration. Reasons:

1. Discussion mode is supposed to answer, not be a Trojan horse
   for engineering work that takes the full wallclock.
2. The iter-161 deploy is in flight; the spec result will land in
   ~10 minutes and is *itself* a diagnostic. Pushing a probe
   right now would race the deploy and clutter logs.
3. The right diagnostic probe doesn't exist yet — it needs to
   send a Yjs edit and wait for a `pdf-segment` reply. That's a
   sibling of `probe-live-ws-payload.mjs`, ~50 lines of code.

So the sequencing is:

- **Iter 163** (next): read the M8.pw.4 result from iter-162's
  deploy. Three possibilities:
  - (a) **Spec passes green.** Then the loop demonstrably works
    in CI but not for the human user. Difference is likely
    timing (CI gives it 240s; human gave it less) or
    Machine-state (CI cold-starts a fresh per-project Machine
    via `createProject`; human reused an existing project whose
    Machine may have OOM'd, stalled mid-compile, or be running
    a stale image). Concrete next probe: pick the
    user-affected project ID, hit it with a write-bearing
    payload probe (extending `probe-live-ws-payload.mjs` to do
    a Yjs insert and wait ≤240s for a `pdf-segment`), and read
    `flyctl logs -a tex-center-sidecar` during the probe.
    Tighten the spec to also exercise the "reuse an existing
    project" path, since that's what real users do — the
    current spec always seeds a fresh project, which is a
    different code path through `upstreamResolver.ts`.
  - (b) **Spec fails on the `pdf-segment` poll.** Then the
    write→compile→frame path is broken in CI too — same as your
    user-test. Either the sidecar isn't reacting to Yjs updates
    (no recompile trigger, e.g.
    `SupertexDaemonCompiler` not subscribed to `Y.Doc` change),
    or the engine errors out, or the response frame isn't
    routed back through `wsProxy`. The CI failure logs and
    `flyctl logs -a tex-center-sidecar` together will say
    which.
  - (c) **Spec fails on the canvas-pixel check.** Frames arrived
    but PDF.js client-side rendering bailed. Then it's
    apps/web's `Preview.svelte` (or whatever the component is).
    Browser console in the Playwright traces will identify it.
- **Iter 164** (or 163 if the result is in hand cheaply):
  implement the actual fix for whichever branch is hit, plus a
  regression spec/probe that locks the failure mode. Specifically
  for branch (a) I want to add an "existing-project edit"
  variant to M8.pw.4 that does NOT create a fresh project, so
  the next regression in the reuse path gets caught.

I am committing to driving this to green-with-real-user-test
before #2, per your instruction.

## #2 — Save feedback

Agreed. Plan:

- New compact `SyncStatus` indicator wired to the Yjs provider's
  sync state. Three visual states:
  - **Idle / saved** — small dim "Saved" pill next to the file
    name in the header (or wherever the filename is rendered),
    no animation. Default.
  - **Syncing** — same pill flips to "Saving…" with a faint
    pulse. Triggered when the Yjs provider has unflushed local
    updates or an in-flight WS send; debounced so fast typing
    doesn't flicker (250ms tail).
  - **Error** — red pill "Save failed", persistent (no
    auto-dismiss), with a tooltip showing the last error. Fires
    on WS close-without-clean-handshake, persistence-NACK from
    sidecar, or write-side timeout.
- Driven off the same `ProviderState` machinery the WS proxy
  already exposes, not per-keystroke. Source of truth is "the
  last update we sent has been ack'd by the sidecar persistence
  layer" — not "we typed a character". Avoids the trap of
  showing "Saved" before the blob store has actually flushed.
- Lock-in tests:
  - apps/web unit test for the state-machine (pure function: WS
    events in, indicator state out).
  - Playwright spec on the local target (no live deploy needed
    to lock the affordance behaviour): type, observe "Saving",
    wait for sync, observe "Saved", drop the WS server-side,
    observe "Save failed" and that it does NOT auto-dismiss.
  - A live variant under `TEXCENTER_LIVE_TESTS=1` that just
    checks the indicator reaches "Saved" within a generous
    window after typing on the live site. (Cheap regression
    against another silent-save-failure.)

Sequenced after #1 lands green.

## PLAN.md updates

I will add the iter-163/164 diagnostic-and-fix slots and an
explicit iter-165 slot for the save-feedback UI under the
existing CRITICAL PATH section, and adjust the FREEZE-lift
criterion: the freeze now lifts on **the M8.pw.4 spec going
green AND a write-bearing live verification (either iter-157-
style probe extended, or the spec's own write path) confirming
edit→pdf-segment**. Spec-green alone is no longer sufficient
because we've now seen empirically that the spec's assumptions
can pass while the user-flow doesn't — the seeded-fresh-project
vs. reused-existing-project distinction is the obvious gap.

## Commitments

- I will NOT mark the FREEZE as lifted until both (a) M8.pw.4
  runs green automatically AND (b) someone (CI or probe) has
  exercised the edit→pdf-segment path against a reused
  pre-existing project, not just a fresh seed.
- I will NOT start the save-feedback UI work until #1 is closed
  with a green automated check that locks the failure mode.
- If the iter-162 live-pipeline run reveals neither (a) nor (b),
  I will report the actual failure shape in the iter-163 log,
  not guess.

## Follow-ups

- The seeded-vs-reused project distinction in M8.pw.4 is a real
  hole; logged as iter-164 work. May be worth a `FUTURE_IDEAS`
  entry for "spec parity with realistic user-flow shape" beyond
  this one case.
- Manual `creds/`-driven write-bearing probe could be a stretch
  scripted addition this iteration if there's wallclock left
  after the answer + PLAN edit, but I'll keep this iteration to
  the answer + PLAN per discussion-mode discipline.
