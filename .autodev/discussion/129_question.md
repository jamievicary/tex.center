# Live site is broken — 500 after Google OAuth consent

## Symptom (reported by user)

Visiting https://tex.center renders the white sign-in page
correctly. Clicking "Sign in with Google" takes the user
through Google's consent flow successfully. **The 500 happens
on return — i.e. on `GET /auth/google/callback?…`** — not on
`/auth/google/start`.

So the regression is in the callback path, not the start path.
The callback's work is: parse `state`/`code` from the query,
verify the signed state cookie, exchange code+verifier for
tokens at Google's token endpoint, JWKS-verify the ID token,
check `email` against the allowlist, **upsert the user row in
Postgres**, **insert a session row**, mint the signed
`tc_session` cookie, 302 to `/editor` (or `/projects`
post-iter-68).

In iter 76 the start path was verified working but the
callback was *not* fully exercised live — only the local-app
side of the handshake (`/auth/google/start` 302) was probed.
Anything DB-side could have regressed since then without HTTP
probes noticing.

## Likely cause hypotheses (verify before fixing)

The DB-side of the callback is the most plausible suspect:

- `findOrCreateUserByGoogleSub` / `insertSession` from iter 37
  both go through `@tex-center/db`, which needs `DATABASE_URL`.
  If `DATABASE_URL` is unset on the live control plane, those
  calls throw at the DB-handle resolution layer.
- iter 105 added migration-on-boot to the control plane, gated
  on `DATABASE_URL`. If DATABASE_URL is set but points at a
  Postgres that hasn't been provisioned, app boot or first
  request will fail.
- Per PLAN, M7.1.3.1 is the manual one-shot `flyctl postgres
  attach`; verify whether that step has actually been done or
  is still outstanding.

Other possibilities worth ruling out quickly:

- iter 95's custom Node entry not propagating thrown errors
  from the SvelteKit handler — would cause every server-side
  exception to surface as a bare 500 regardless of root cause.
- A Google Cloud Console redirect-URI mismatch (would
  typically surface as a Google-side error page, not a
  same-origin 500, but worth confirming).

## What to do this iteration

Treat as a **production-down incident**. Park the FUTURE_IDEAS
backlog and the M7.5.x daemon work until the live site
completes an OAuth round-trip end-to-end.

1. **Pull live logs first.** `flyctl logs --no-tail -a
   tex-center` and look for the stack trace from the latest
   500. The top frame points straight at the bug.
2. **Cross-check Fly secrets and Postgres attachment.**
   - `flyctl secrets list -a tex-center --json` — confirm
     `DATABASE_URL` is set (and the iter-76 OAuth secrets are
     still present).
   - `flyctl postgres list` and `flyctl pg attach` status —
     confirm a Postgres has been provisioned for `tex-center`
     and is attached. If not, attaching it is a real part of
     fixing this; M7.1.3.1 was always going to need doing.
3. **Probe the live site to characterise the failure.**
   Can't drive a real OAuth round-trip headlessly, but can:
   - `curl -i https://tex.center/readyz` — does the new
     readiness endpoint (iter 127) report `db: up` or
     `db: down`? That alone may answer it.
   - `curl -i 'https://tex.center/auth/google/callback?error=fake'`
     — exercises the callback's pre-DB branches; should 302
     to `/`, not 500. If it 500s, the issue is upstream of DB.
4. **Fix the root cause.** If Postgres isn't attached, attach
   it. If `DATABASE_URL` is set but unreachable, diagnose. If
   the custom Node entry is eating exceptions, fix the entry.
   Don't ship a workaround that hides the symptom (e.g. a
   try/catch that swallows the DB error and proceeds without
   a session); the user must end up signed in on the other
   side.
5. **Redeploy and verify.** Don't declare success until
   `flyctl logs` shows a clean callback request, and the
   user (the only consenting account) can be told to retry
   the click-through with a high expectation it'll work.
6. **Extend `deploy/VERIFY.md`** with the callback's
   pre-DB-branch probe from step 3 as a hard gate on future
   deploy-touching iters. The full OAuth round-trip can't be
   automated headlessly, but the `?error=fake` synthetic probe
   exercises everything up to (and including) the
   custom-Node-entry layer.
7. **Carry forward as the canonical M8.pw.2 case.** Once M8
   Playwright wires its `live`-target suite into deploys, an
   `authedPage` fixture that asserts on the post-callback
   `/projects` page will catch this exact class of regression.
   Don't bundle that with this fix.

## On priority

The user wrote: "still nothing hosted on tex.center apart from
a Google login box that takes me to a 500 error. disappointing."
That's the level of urgency to apply. The project looks like a
broken demo until the OAuth round-trip succeeds end-to-end.
This fix takes precedence over every other queued slice.
