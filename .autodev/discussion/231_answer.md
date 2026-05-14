# 231 — GT-6 is passing but the slow project-load is still happening on v231

## Agreement

You're right on every point. The current GT-6
(`tests_gold/playwright/verifyLiveGt6FastContentAppearance.spec.ts`)
short-circuits exactly the work that produces the user-visible
latency. Three independent ways:

1. **Pre-warmed Machine + first-segment.** The shared
   `liveProject` is bootstrapped by `globalSetup.ts` (via
   `fixtures/liveProjectBootstrap.ts`), which goes far past
   "project row exists": it launches a transient Chromium,
   navigates `/editor/<id>`, and *waits for the first
   `TAG_PDF_SEGMENT` frame on the project WS* before returning.
   By the time GT-6 runs, the sidecar Machine for that project
   is up, the supertex daemon has already shipped a PDF, and the
   project's R2 blob (or whatever doc-state lives server-side)
   is hot. The user-reported flow is none of those.
2. **Direct `goto /editor/<id>`, not click-from-/projects.** The
   spec calls `authedPage.goto("/editor/${liveProject.id}")`
   from a fresh browser context. SvelteKit's projects-list →
   editor client-side nav, the SPA-internal hydration sequence
   that triggers, the `+page.ts` load that runs against an
   already-mounted root layout — none of that is exercised.
3. **Hot project state across the suite.** GT-6 runs after
   GT-A→B→C→D→5 in file-sort order. By that point the project
   has been opened in three browser contexts, edited multiple
   times, and re-compiled. The shared fixture is "warm" in
   every dimension that matters.

And the threshold is wrong for the stated UX target. 2000ms is
"the user notices a delay and starts waiting"; "feels
instantaneous" lives well under 500ms.

So the test does not pin the regression. The user-reported
behaviour ("tens of seconds for source to appear") is consistent
with the editor source-render path being *gated on something on
the sidecar critical path* (Yjs-over-WS sync, supertex daemon
ready, first compile, …) instead of streaming directly from the
authoritative server-side blob. Until GT-6 is RED on a flow that
exercises that gating, no fix can be validated.

## Strengthened GT-6 design

I'll land this in iter 232 (the next ordinary iteration; this
discussion-mode iteration is too narrow for the full slice
including a live smoke-test cycle). Design:

- **Per-test fresh project, not the shared `liveProject`.**
  Create the row inline in `beforeEach` via the existing `db`
  worker fixture (`createProject` from `@tex-center/db`). The
  project owns nothing else: no Machine has ever been assigned,
  no R2 blob has been written, no Yjs awareness has ever
  attached. This is the canonical user-visible cold-click case
  (and matches what GT-8 already does for the cold-newpage
  regression — same `createProject` + `cleanupProjectMachine`
  pattern, different assertion).
- **Click from `/projects`, not direct goto.** The flow is:
  1. `authedPage.goto("/projects")` and wait for the project
     link to appear (the page lists projects owned by the test
     user, including the just-created one).
  2. `authedPage.click(\`a[href="/editor/${project.id}"]\`)` —
     SvelteKit client-side navigation, mirroring what the user
     does with the mouse.
  3. Mark the moment the editor route becomes interactive
     (`waitForURL("**/editor/**")` plus
     `waitForLoadState("domcontentloaded")`).
- **Tight bound: 500 ms on `.cm-content` source after editor
  becomes interactive.** Source content lives server-side
  (authoritative blob in R2, served by the web app or proxied
  through the sidecar). On a cold project there is no edit
  history yet, so the "source" is the seed template containing
  the `documentclass` sentinel — we already know that string
  goes into the project at creation time. 500ms is the
  budget; if the implementation today gates source render on
  Yjs-after-sidecar-ready, that bound will be tens of seconds
  and the test will be unambiguously RED.
- **No artificial Machine kick.** I considered explicitly
  destroying any pre-existing Machine before navigation (to
  force the cold-sidecar path even on previously-opened
  projects). For a freshly-`createProject`'d row no Machine has
  ever been assigned, so the cold-sidecar path is automatic and
  the explicit step is unnecessary. That keeps the test simple.
- **Per-test cleanup.** `afterEach` runs
  `cleanupProjectMachine` against the freshly-created project,
  then deletes the row. Same primitives the GT-8 spec and the
  shared bootstrap teardown already use.
- **Diagnostic-friendly failure message.** Already present in
  the current spec (captures elapsed-since-nav, elapsed-since-
  goto, first 120 chars of `.cm-content`). Keep it; add the
  current `liveProject.id` and the page URL at the moment of
  the failure for triage.

## Why I'm not bundling the fix

You said "do not attempt the fix yet — that's the next
iteration after GT-6 is genuinely RED" and I agree. The discipline
from iter 224 (GT-8 cold-project repro) was: get the test RED on
live, then fix, then watch it flip to GREEN. Anything else
re-enters the failure mode where a fix appears to land but the
user keeps seeing the bug because the test never exercised it.

Specifically, M13.1 (`performance.mark` instrumentation on the
hydrate path) is the right *diagnostic* probe to run *after*
GT-6 is RED so we know which sub-step (connect, sync,
CodeMirror bind, R2 hydrate, sidecar wait, …) dominates. That
becomes the iter-233+ work.

## Smoke-test commitment

Iter 232 will:

1. Land the strengthened GT-6 spec (no fix changes anywhere
   else in `apps/` or `src/`).
2. Run it against live in isolation
   (`pnpm exec playwright test --project=live --grep Gt6 \
   --grep-invert nothing`) with `TEXCENTER_FULL_PIPELINE=1`,
   confirm it goes RED with an elapsed-time message that
   matches the user's "tens of seconds" report.
3. If it is *unexpectedly* GREEN on live: don't commit a green
   test that pins nothing. Either (a) tighten the threshold
   further until RED, or (b) drop the spec, write up what was
   found in the iter-232 log + PLAN, escalate via discussion if
   the user's symptom can't be reproduced from the new flow
   either (which would itself be a finding worth knowing).
4. If RED: leave it RED, update PLAN to mark the slice "pinned,
   awaiting fix in iter 233+", and stop.

## Meta-protocol

Acknowledged: the iter-224 lesson generalises. A pinning test
that has never been RED is not a pinning test, it's
infrastructure that decorates the suite. Smoke-RED-on-live is
the gate, not "looks-like-it-should-fail".

## Decisions / commitments

- Strengthened GT-6 design above is final unless it turns out
  in iter 232 that one of the assumptions (e.g. "fresh project
  has the seed template ready to render") doesn't hold; then
  iter 232's log will explain and the next iteration adjusts.
- 500 ms threshold is the starting point. If RED with elapsed
  ~tens of seconds, perfect. If RED with elapsed only ~600 ms
  on live, leave at 500 ms — that's still a real regression
  signal even if not as dramatic as the user-reported case.
- This iteration ships only `231_answer.md` and the PLAN entry
  update; no test or `src/` changes.
