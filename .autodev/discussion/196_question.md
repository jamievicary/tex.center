# 196_question — separate cold-start warm-up from per-spec assertions

User-raised 2026-05-13 (between iter 195 and 196). Independent of
the M9 daemon-protocol work in `195_question.md` / `195_answer.md`;
this is a gold-suite structure change that pays back regardless of
the M9 outcome.

## The problem

Gold-suite wallclock has crept from ~2 min to ~10–13 min since iter
190. Diagnosis (no edits made, transcript in conversation): GT-3
and GT-5 (currently RED on live per PLAN.md M9) sit out their full
internal timeouts on every run. Each spec's polls budget for
cold-start tail:

- `verifyLiveGt3EditTriggersFreshPdf.spec.ts:64` —
  `timeout: 240_000` on initial pdf-segment.
- `verifyLiveGt3EditTriggersFreshPdf.spec.ts:87` —
  `timeout: 60_000` on post-edit pdf-segment.
- `verifyLiveGt5EditUpdatesPreview.spec.ts:65` —
  `timeout: 240_000` on initial pdf-segment frames.
- `verifyLiveGt5EditUpdatesPreview.spec.ts:107` —
  `timeoutMs: 60_000` on `expectPreviewCanvasChanged`.

When the feature works these polls return in well under a second;
they exist purely as cold-start absorbers. When the feature is
broken (current M9 state), they consume their full budget. Two RED
specs × ~5 min each ≈ ~10 min of pure timeout grinding, which is
exactly the observed regression.

## The user's proposal

Warm the machine **before** any timed assertion runs. Then per-spec
timeouts can shrink dramatically and breakage produces a fast,
high-signal failure instead of a 5-minute timeout.

Two-phase fixture shape:

1. **Warm-up (one-shot, generous):** before any spec asserts, put
   the live machine in a known-warm state. Boot, sidecar ready,
   daemon spawned, WS handshake, **initial pdf-segment frame
   observed**, canvas painted, snapshot hash non-null. Allowed to
   take a couple of minutes — amortised across the whole run.
   Lives in `globalSetup.ts` or as part of the `sharedLiveProject`
   fixture (`tests_gold/playwright/fixtures/sharedLiveProject.ts`,
   which today reuses the project ID but doesn't gate on "first
   pdf-segment seen").
2. **Per-spec assertions (tight):** every spec starts with the
   invariant "machine is warm, initial PDF rendered." Initial-poll
   timeouts shrink from 240_000 → ~5_000; post-edit polls from
   60_000 → ~10_000.

## Why this is worth doing independently of the M9 fix

- **Failure mode becomes useful.** Today a GT-5 timeout could mean
  the feature is broken, the machine is cold-stuck, the sidecar
  wedged, PDF.js slow, or the WS upgrade failing. With warm-up
  separated, a spec timeout is unambiguously "the feature is
  broken."
- **Cold-start health becomes its own metric.** The warm-up step
  *is* the cold-start regression test. If it ever blows past N
  seconds, you have a direct signal of a Fly/sidecar/daemon
  boot-time regression. Today the same signal is diluted across
  ten specs and easy to miss.
- **Successful specs also get faster** because they stop paying
  for the cold-start budget they don't need on the shared warm
  machine.
- **Independence from M9.** Even before the new daemon protocol
  (195) lands, GT-3/GT-5 would fail in ~10s instead of ~5 min,
  restoring gold wallclock to a usable range.

## Implementation notes

- Warm-up's success criterion has to actually exercise the path
  every spec relies on. Not just "WS open" — must include "initial
  `pdf-segment` frame observed, canvas painted, snapshot hash
  non-null." Otherwise GT-3/5's initial polls could still time out
  on a quirky daemon state.
- After warm-up, each live spec navigates to the same shared
  project URL. The page object is per-test (Playwright doesn't
  share pages across tests by default), so the warm-up's value is
  *server-side*: the Fly machine + sidecar + daemon are alive and
  have produced at least one PDF. Each spec's new page hits a
  ready-to-respond backend.
- `sharedLiveProject` currently lives at
  `tests_gold/playwright/fixtures/sharedLiveProject.ts`. The
  natural seam is to extend that fixture with a "wait for backend
  warm" step, or to put the warm-up in `globalSetup.ts` so it's a
  pre-flight pass that produces a typed handle the fixture exports.
- Timeout values are a judgement call: I'd suggest 180_000 for the
  warm-up step itself (cold Fly machine + sidecar boot + first
  compile can hit ~60–90s realistically, plus headroom), then
  5_000 for initial-frame polls on warm-machine specs and 10_000
  for "after edit" polls. Tune from the first few warm-machine
  runs.
- The first warm-up run after a deploy will still take real wall
  time. That's expected; the gain is on the n=2..k cases that
  dominate iteration. If desired, a separate `--cold` flag could
  skip warm-up and exercise the cold path explicitly as its own
  spec.

## Scope

Pure gold-test restructure. No production code touched. Land
independently of M9; the two compose cleanly. Worth doing in iter
196 if the iter-195 daemon protocol slice closes out cleanly, or
in parallel as a second priority.
