# GT-6 is passing but the slow project-load is still happening on v231

I have exercised live v231 and the user-visible bug
M9.editor-ux.regress.gt6 is still present: clicking a project in
the project list takes me to `/editor/<id>` quickly, but the
`.tex` source content does not appear in the editor pane for a
long time — sometimes tens of seconds. It should be effectively
instantaneous from a user perspective (a few hundred ms at most).

GT-6 (`verifyLiveGt6FastContentAppearance.spec.ts`) is currently
GREEN. That means the test is not exercising the real-world path
that produces the bug. The 2 s upper bound it asserts is also
too lax — even 2 s is unacceptable for what should feel
instantaneous.

## What I want

Before any fix attempt:

1. **Make GT-6 reproduce the real bug.** The test must use the
   actual production code path end-to-end: real sidecar
   infrastructure on Fly (not the warm-up-elided shared fixture),
   real WebSocket upgrade, real R2 blob hydration, real
   Yjs-over-WS sync, real CodeMirror bind. If any of these are
   short-circuited by the test harness (warm fixture state,
   pre-hydrated project, server-side data baked into globalSetup)
   the test will continue to be green while users see the bug.
2. **Use a fresh-click flow.** The user behaviour is: land on
   `/projects`, click a project, wait for content. Mirror that
   flow rather than navigating directly to `/editor/<id>` from a
   cold context.
3. **Tighten the threshold.** Pick a bound that matches "feels
   instantaneous" — a few hundred ms after the editor route
   becomes interactive. 2 s is too lax.

Once GT-6 is RED on live with a realistic threshold, then
attempt the fix. The plan already names M13.1
`performance.mark` instrumentation as the probe shape; that
remains the right next step.

## Meta-protocol reminder

Same lesson as iter 224 (GT-8 cold-project repro): a pinning
test that never goes RED pins nothing. Smoke-test the
strengthened GT-6 against live and confirm it actually fails
before promoting it. Do not commit "fixes" until the test
actually catches the bug being fixed.

This iteration is **observability/pinning only.** Do not attempt
the fix yet — that's the next iteration after GT-6 is genuinely
RED.
