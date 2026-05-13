You're right, and the recent activity got more baroque than it
needed to. The simple "warm up explicitly, then short
independent budgets per test" approach is achievable, and the
reason we drifted away from it is worth naming.

## Why we ended up here

The current shape uses a Playwright **worker-scoped fixture**
(`sharedLiveProject`) to create one Fly Machine + project and
share it across the four GT specs (workers: 1, so effectively
session-scoped). That fixture is Playwright-idiomatic; it's also
the source of the timeout muddle.

Playwright runs worker-scoped fixture setup **lazily, inside the
first test that requests the fixture**. That means:

- The first GT spec's budget has to cover both warm-up
  (~60–180s on a cold Fly boot) AND its own work.
- `test.setTimeout(N)` inside a test body can't retroactively
  cover fixture setup that already ran — it resets the
  *remaining* budget. Iter 206 hit this and iter 207 patched it
  by raising the global `timeout` to 240s.

So we now have a 240s budget on *every* test, just to cover the
worst case of "first test pays the warm-up tax." That's exactly
the kind of slack-tuning the anti-flake rules forbid in spirit:
one slow test can hang for 4 minutes before failing, and the
budget no longer tells us anything about per-test expectations.

## The proposal you're suggesting

1. Do warm-up explicitly, **outside** the per-test timeout
   regime — in `globalSetup.ts`, with its own dedicated budget
   (e.g. 240s).
2. globalSetup creates the live Fly project + Machine, drives
   the first lualatex round to warm the sidecar, and writes the
   resulting `project_id` (+ cookie material) to an env var or
   small JSON file.
3. globalTeardown reaps the Machine + project row.
4. The `liveProject` fixture becomes a thin reader of that
   bootstrap state, not a setup step. Per-test budget drops to
   something tight — say **45s** for GT-A/B/C/D — so a hung
   test fails fast and the next one runs.

This is strictly better:

- **Bounded blast radius** for any single test going wrong.
- **Per-test budgets become diagnostic** again: a GT-C taking
  45s is a regression, not "noise within the 240s ceiling."
- **One place** to read the warm-up cost, with its own
  meaningful budget that doesn't contaminate test budgets.
- The teardown path is the same code; just hung in
  globalTeardown instead of a fixture's `finally`.

## Cost / what we lose

- globalSetup runs in the Node test runner, not the browser
  context, so the warm-up "first lualatex round" has to be done
  via HTTP/WS calls from Node rather than a Playwright `page`.
  That's a modest amount of code (we already have `mintSession`
  and the sidecar's WS contract is well-defined) and is more
  honest about what warm-up actually is.
- All four GT specs need a small refactor: instead of importing
  `test` from `sharedLiveProject.ts`, they import a slim
  fixture that reads the pre-baked project id from env. That's
  mechanical.

## Commitment

Next ordinary iteration: implement the above.

- Move Fly Machine + project bootstrap from
  `sharedLiveProject.ts` into `globalSetup.ts`, behind
  `TEXCENTER_LIVE_TESTS=1`.
- Add `globalTeardown.ts` for the reap.
- Export `TEXCENTER_GT_PROJECT_ID` (+ cookie token if needed)
  for specs to consume.
- Drop the worker-scoped fixture down to a per-test reader.
- Set per-test `timeout` to 45_000ms (still generous; live
  network + browser navigation isn't 0). globalSetup carries
  its own 240s.
- Verify GT-A through GT-5 all green under the new regime.

I'll update `.autodev/PLAN.md` with a one-liner pointing at
this when I land it.
