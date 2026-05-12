# Answer — pivoting to the live MVP P0

## Agreement

The diagnosis is sound and I agree with the framing.

- **Three symptoms, one most-plausible cause.** Save doesn't happen,
  file-CRUD does nothing, no PDF ever appears. The architecture
  routes all three through the same WS (Yjs awareness + Yjs doc
  updates for saves, file-tree verbs, and `pdf-segment` frames).
  Page-level routing, DB, and cookie auth obviously work because
  login / project list / project open all work — those are HTTP
  routes that don't touch the sidecar. The one thing those three
  failures *share* and the working flows *lack* is the WS path
  through `wsProxy.ts` → `upstreamResolver.ts` → sidecar Machine.
  This is the right load-bearing hypothesis. Verify first; don't
  fix anything until the failure is localised.

- **Iter-76 pattern is repeating.** "Test exists, isn't run,
  regression it would have caught is live" is the precise failure
  mode of M8.pw.4 being `[~]` with operator-gated activation since
  iter 137 (~8 ordinary iterations ago). Each repeat costs a
  production-down regression. The structural fix — automatic
  execution on every deploy — must land this time.

- **Pause cron rituals + M7.4.2 + post-MVP M7 work.** Refactor-
  at-N%10 and plan-review-at-N%11 are maintenance for a healthy
  project. The project isn't healthy. They should resume only when
  `verifyLiveFullPipeline.spec.ts` runs green on every deploy.
  M7.4.2 is real engineering work but doesn't unstick the user.

- **PLAN.md needs a rewrite.** 306 lines, organised as a milestone
  diary, no visible "critical path to MVP" up top. Agreed. Do it
  the iteration *after* the live fix lands, per your guidance.

## A small disagreement / refinement on sequencing

The question prescribes "do all of it this iteration" for step 1
(provision test OAuth client in GCP, run `google-refresh-token.mjs`,
push secrets, run `verifyLiveFullPipeline.spec.ts`). I can't
provision a GCP OAuth client end-to-end — that's a browser-only
human step in the GCP console (create client, accept ToS, copy
client ID + secret). The OAuth refresh-token grant *can* be
scripted from my end once a client exists and you've consented
once, but the consent step is also browser-only.

So the literal "activate M8.pw.4 now" requires you. That's not
the bottleneck though — the WS diagnosis doesn't depend on
M8.pw.4 being green. I can probe live WS directly with a minted
session (no OAuth involved) and pinpoint the failure layer this
iteration / next.

What I'm proposing instead, in priority order:

1. **This iteration (the one you're reading):** lock in the pivot
   in PLAN.md (pause cron, pause M7.x post-MVP, elevate live-fix
   priority, point next iter at the WS probe). Land the cheapest
   anon probe to confirm the front-door isn't catastrophically
   broken.
2. **Next iteration:** flyctl-proxy live Postgres → `mintSession`
   for the user — there's a `creds/live-user-id.txt` already → WS
   probe `wss://tex.center/ws/project/<a-real-owned-project-id>`
   with the cookie. Capture status code + which side hangs.
   Diagnose the failure layer per your script (upgrade-fails-403
   → M7.2 owner_id check; upgrade-succeeds-no-frames → sidecar;
   anything else → routing/auth).
3. **Iteration after that:** fix the root cause, add a regression
   test that proves it stays fixed, redeploy, re-probe.
4. **Iteration after that:** wire it into deploy verification —
   either fold an authed-WS probe into the existing
   `verifyLive.spec.ts` (which already runs on every deploy via
   `TEXCENTER_LIVE_TESTS=1`), or get M8.pw.4 active. The authed-
   WS-probe path is the more directly attackable one for me
   (doesn't need GCP console). M8.pw.4 still needs you to
   provision the test OAuth client.
5. **Iteration after that:** PLAN.md rewrite per your spec
   (≤80 lines, critical-path-first).

This is one or two iterations longer than the question's
sequencing, but the extra iterations are real engineering steps
(the diagnosis and the fix), not bureaucracy.

## What I did this iteration (concrete actions)

- **Anon WS probe of live.** Direct HTTPS Upgrade to
  `wss://tex.center/ws/project/00000000-...-000000000000` (no
  cookie). Response: `HTTP/1.1 401`, `connection: close`,
  `fly-request-id: 01KRDRNTYYN286TN23HSHT0H1Z-lhr`. Body empty.
  This rules out three failure modes:
  - Fly proxy isn't routing `/ws/*` to the control plane (would
    be 404 / 502 / TLS error).
  - Control plane is crashing on WS upgrade (would be 502 /
    timeout).
  - WS handler isn't installed at all (would be a 200 SvelteKit
    page render or a 404 from the catch-all).

  It does **not** rule out the most likely culprit — the auth
  decision returning `deny-anon` *for a real signed-in user too*,
  because an authed probe is what tells those apart. Doing that
  needs the flyctl-proxy + mintSession dance and is the next-iter
  task.

- **PLAN.md updates** to lock in the pivot:
  - Top of file: a "Priority: live MVP non-functional" block
    naming the suspected WS hypothesis, the diagnostic next step,
    and the pause list.
  - Mark cron rituals (N%10, N%10==1) paused until M8.pw.4 (or an
    authed-WS deploy probe) runs green on every deploy.
  - Move "next ordinary iteration: M7.4.2" → "deferred until live
    MVP is unblocked".

- I'm **not** doing the GCP OAuth provisioning, the
  flyctl-secrets push, or the live `verifyLiveFullPipeline.spec.ts`
  run this iteration. The OAuth-client provisioning is a human-
  only step; the rest depends on it, and tacking on a half-done
  setup ends with a wedged credentials directory the next
  iteration has to untangle.

## Commitments

- Next ordinary iteration: authed WS probe of live (flyctl-proxy
  + `mintSession` + WS handshake with cookie). Capture exact
  failure layer. Single-purpose iteration; no fix attempt until
  the layer is known.
- Iteration after: fix + regression test + redeploy.
- Iteration after: wire an authed-WS check into the deploy-time
  spec so this can't silently regress again.
- After live MVP is unblocked + deploy-gated: PLAN.md rewrite per
  spec.
- Cron rituals stay paused until that gate is live.

## Operator asks (when you have time, not blocking)

If you want M8.pw.4 itself to be the deploy-time gate (rather than
an authed-WS probe inside `verifyLiveCallback` / `verifyLive`),
you need to do the GCP test-client provisioning once. The flow is
in `.autodev/PLAN.md` § "Live activation (operator-gated)" — short
version: create a new OAuth client in GCP for tex.center with
redirect URI `http://localhost:4567/oauth-callback`, save the JSON
as `creds/google-oauth-test.json`, run
`pnpm exec node scripts/google-refresh-token.mjs` once, then
`flyctl secrets set TEST_OAUTH_BYPASS_KEY=$(openssl rand -hex 32)
-a tex-center`.

But please don't block on this — the authed-WS probe path gets
the live MVP working faster, and M8.pw.4 can come later as
defence-in-depth.
