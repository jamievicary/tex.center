# 196_answer — separate cold-start warm-up from per-spec assertions

## Verdict

Agreed, with two refinements on the implementation seam and one
on what "warm" means. Landing this is the right next gold-suite
slice. The diagnosis is correct: a single 4-min initial-PDF
timeout × two RED specs × wallclock-dominant `pdf-segment` polls
explains the entire ~2 → ~10–13 min regression, and decoupling
the cold-start absorber from the per-spec assertions makes
breakage produce a 10-second failure instead of a 5-minute one.
Worth doing independently of the M7.4.x sidecar-protocol fix.

## Refinements

### 1. Fixture seam, not globalSetup

`globalSetup.ts` runs before workers exist and has no knowledge
of the per-worker project that `sharedLiveProject` creates. The
warm-up has to be tied to **that** project's Machine (its sidecar
+ daemon) — a different project's Machine doesn't warm anything
GT-3/5 care about. Two consequences:

- Put the warm-up inside `sharedLiveProject` itself, after
  `createProject(...)` succeeds and before `use(project)`. The
  fixture is already worker-scoped and already pays a one-shot
  cost; this is a small, well-contained extension.
- `globalSetup` is the wrong seam for a separate reason too:
  Playwright's `globalSetup` doesn't have access to the
  worker-scoped fixture's project, and trying to push it earlier
  forces the warm-up to invent its own throwaway project and
  Machine. That would double the per-run Fly cost and leave the
  GT specs' actual project still cold on first use.

So: extend `sharedLiveProject` with a "wait for backend warm" step
that runs once per worker, with the 180s budget you suggest.

### 2. What "warm" means — match exactly the GT-3/5 entry condition

Your implementation-note is right that "WS open" isn't enough. To
make a spec timeout unambiguously mean "the feature is broken,"
the warm-up has to observe the *same* signal GT-3 and GT-5 open
with: an initial `pdf-segment` frame on the shared project's WS.
Anything weaker (only-handshake, only-`compile-status running`)
leaves GT-3's 5s initial poll exposed to "daemon booted but first
compile hasn't shipped yet" races.

Practical shape inside the fixture:

1. Create project (current behaviour).
2. Open a one-shot Playwright `BrowserContext` against the editor
   URL with the authed cookie (same auth flow as `authedPage`).
3. Wait, with the generous 180s budget, for one `pdf-segment`
   frame on the WS — reusing the same wire-frame helper GT-2/3/5
   use, so warm-up and assertion are observing the same thing.
4. Close the warm-up context. Yield `liveProject` to the suite.

Note this **subsumes** GT-2 (`verifyLiveGt2InitialPdfSeeded`) — by
the time any spec runs, the warm-up has already proved an initial
`pdf-segment` arrives for a seeded project. GT-2 doesn't become
redundant though: its tight, per-spec re-check on a *fresh page*
verifies the client-side hydrate path, not just the server-side
compile path. Keep it, but drop its initial-poll timeout to
~5_000 like the rest. If it ever fails, that's now a fast-failing
"page hydrate broken" signal, not a noisy "maybe the machine is
cold" one.

### 3. Cold-start as its own metric

Once warm-up is separated, the time it takes IS the cold-start
regression number. Log it in `.autodev/state/` (or just the
fixture's stderr) on every run; if it ever blows past ~120s,
that's the Fly/sidecar/daemon boot-time alarm the question calls
for. Cheap to add and the value compounds.

## What I am NOT doing in this iteration

Discussion mode forbids bundling unrelated work. The restructure
(fixture extension + five spec timeout edits + a smoke
re-baseline run on the live target to confirm warm-up actually
arrives < 180s) is a coherent slice on its own, not a probe. I
will land it as iter 197.

The M7.4.x work scheduled by `195_answer.md` (build verification
+ diagnose which daemon gate fires) is **deferred to iter 198**
in consequence. Justification: with warm-up in place, GT-3/5
failures will surface in ~10s instead of ~5min, which makes the
diagnostic loop on M7.4.x dramatically faster. The order
"restructure → diagnose" is strictly cheaper than "diagnose →
restructure."

## Concrete plan for iter 197

1. Edit `tests_gold/playwright/fixtures/sharedLiveProject.ts`:
   after `createProject`, before `use`, open an authed
   `BrowserContext`, navigate to the editor, wait up to 180_000
   for an initial `pdf-segment` frame using the existing
   `waitForPdfSegment` / `collectWsFrames` helper. Capture the
   elapsed-ms in a local `console.warn` for visibility.
2. Edit GT-1..5 specs to retarget initial-frame polls to 5_000
   and post-edit polls to 10_000. The post-edit timeout for GT-3
   is currently 60s and GT-5's `expectPreviewCanvasChanged` is
   60s — both shrink. GT-1's `cmContent.waitFor` attached-timeout
   (120s) drops to 10s for the same reason.
3. Run gold against live to confirm: (a) warm-up completes
   inside its budget on a cold machine; (b) green specs (GT-1,
   GT-2, GT-4) take seconds not minutes; (c) GT-3, GT-5 still
   RED but fail fast.
4. Update `.autodev/PLAN.md`: add an M9.gold-restructure note
   and reorder M7.4.x to iter 198.

## Follow-ups committed

- If warm-up itself starts to drift past 120s, file as its own
  upstream-blocker-shaped issue (a Fly/sidecar boot regression,
  not a per-spec problem).
- A `--cold` flag to skip warm-up and exercise the cold path as
  its own spec is a sensible future addition but not required
  for the restructure. Logging it as a `FUTURE_IDEAS.md` line.
