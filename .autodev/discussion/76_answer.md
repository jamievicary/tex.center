# Answer — production OAuth is broken: secrets aren't in the image

## Agreement on the diagnosis

Fully agree. Confirmed each link in the chain before touching code:

- `apps/web/.dockerignore` line 23 excludes `creds`, so the deployed
  image contains no `/app/creds/google-oauth.json`. Iter-42's
  comment in that file is explicit: "Credentials must never enter
  an image layer." Good.
- The old `apps/web/src/lib/server/oauthConfig.ts` opens the creds
  file *before* checking env-var overrides, so even setting
  `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` would not have helped — the
  `readFileSync` ENOENT throws before env is consulted.
- `FLY_API_TOKEN=$(cat creds/fly.token) flyctl secrets list --app
  tex-center` returned zero secrets, so neither the OAuth creds
  nor `SESSION_SIGNING_KEY` were present on the live image.
- Live probe before the fix:
  `GET https://tex.center/auth/google/start` → 500 with the exact
  ENOENT body quoted in the question. Confirmed.

The iter-73 verification was indeed incomplete; treating this as
M6.3.1 in spirit (not a new milestone) is correct.

## Decisions and what I changed this iteration

### 1. Refactored `oauthConfig.ts` — env-first, dev-only file fallback

`apps/web/src/lib/server/oauthConfig.ts` now:

- Reads `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` from
  env first.
- Falls back to reading `creds/google-oauth.json` **only if
  `NODE_ENV !== "production"`** and the env var is unset. Production
  never opens the file, so a missing file can no longer mask a
  missing env var.
- Error messages on missing env vars now name the env var and point
  the operator at `flyctl secrets set` (prod) vs
  `creds/google-oauth.json` (dev).
- `SESSION_SIGNING_KEY` and `GOOGLE_OAUTH_REDIRECT_URI` were already
  env-only on every path; left as-is.

I kept the env-var prefix `GOOGLE_OAUTH_` (matching the existing
code) rather than the question's bare `GOOGLE_CLIENT_ID` — the
prefix disambiguates from any future Google API usage and the
existing names had zero other callers to migrate (grepped).

I did **not** build the suggested "pnpm dev wrapper that exports
env from JSON" or `.env.local` plumbing. The simpler shape — env
takes precedence, dev path silently falls back to the JSON file
when env is unset — preserves the existing local-dev ergonomics
(no new wrapper, no `.env.local` to author) while still making
production env-only. The "file fallback should not survive in the
production code path" rule is honoured by the `NODE_ENV` guard.

### 2. Secret audit — only the OAuth creds were file-bound

Grepped `apps/web/src` for `readFileSync`, `creds/`, `DATABASE_URL`,
and `process.env.`. Findings:

- `sessionConfig.ts` (`SESSION_SIGNING_KEY`) — already env-only,
  returns `null` if unset, throws on malformed value. No change.
- `db.ts` (`DATABASE_URL`) — already env-only, clear missing-env
  error. No change. (See §4 below for the live-state question.)
- `oauthConfig.ts` — fixed as above.
- Sidecar tier (`apps/sidecar/src`) — not part of the control-plane
  image; not yet deployed (M7.0.2 is the next slice). When that
  lands it gets the same audit; out of scope here.

Only `oauthConfig.ts` was reading from disk in production.

### 3. Pushed secrets to Fly and redeployed

Generated a fresh `SESSION_SIGNING_KEY` (32 random bytes,
base64url-encoded, 43 chars) — distinct from any local-dev default,
generated per the question's command — and pushed:

```
flyctl secrets set --app tex-center \
  GOOGLE_OAUTH_CLIENT_ID=…  GOOGLE_OAUTH_CLIENT_SECRET=… \
  GOOGLE_OAUTH_REDIRECT_URI=https://tex.center/auth/google/callback \
  SESSION_SIGNING_KEY=…  NODE_ENV=production
```

The rolling restart picked up the env, but the deployed image
still had the old `readFileSync` code (secrets alone don't change
the binary). Ran `flyctl deploy --remote-only --app tex-center
--config apps/web/fly.toml` to ship the refactored image. The
remote builder reused the existing layer cache except for the
SvelteKit build; total wallclock ~3 min.

### 4. End-to-end verification against the live site

Post-deploy probes (run from this host, via `fetch`):

- `GET https://tex.center/healthz` → 200, body
  `{"ok":true,"protocol":"tex-center-web-v1"}`.
- `GET https://tex.center/auth/google/start` → **302** to
  `https://accounts.google.com/o/oauth2/v2/auth?...` with the
  expected `client_id=103831559961-ouq4t3u9b56kbp1geii8sgcrv6ep74oq…`,
  `redirect_uri=https://tex.center/auth/google/callback`,
  `code_challenge_method=S256`, `state`, `prompt=select_account`.
  The verifier is correctly absent from the URL (it's in the
  signed state cookie).

The OAuth start endpoint is functional. The next step — clicking
through Google's consent page back to the callback — depends on
the Google Cloud Console having
`https://tex.center/auth/google/callback` listed under "Authorized
redirect URIs" for this OAuth client. Per `GOAL.md` and the
question, that step is not API-driven and is on the user's plate.

### `DATABASE_URL` and `/healthz`

`/healthz` (iter 45) deliberately does **not** touch the DB so a
Postgres outage can't scale the app to zero. The live response
body is constant (`{"ok":true,"protocol":"tex-center-web-v1"}`)
and does not report DB state. The question asked whether the
live app reports DB up/absent — answer: it doesn't, by design.
The DB-touching variant from iter 18-era code lives at request
handlers that need it; none of those are on the public path
today, so `DATABASE_URL` is unset on Fly. When M7.x wiring lands
that needs Postgres (project rows, sessions, etc.), `DATABASE_URL`
gets pushed at the same time and `VERIFY.md` will grow a DB probe.

### 5. `deploy/VERIFY.md`

Added. Three probes (healthz, root, oauth-start) with explicit
non-200/non-302 → failure semantics, the manual Google Console
prerequisite called out, and a table of expected Fly secrets. The
"stability is the round-done signal" framing from
`PdfStabilityWatcher` carries over: a green `flyctl deploy` is not
a working deploy until those three probes pass.

## What remains for the user (out of agent's control)

The Google Cloud Console step. The redirect URI
`https://tex.center/auth/google/callback` must be listed under
the OAuth 2.0 client's "Authorized redirect URIs" page. Project
`tex-center` / OAuth client matching the `client_id` above. If
clicking through "Sign in with Google" returns
`redirect_uri_mismatch`, that's the missing entry — add it in the
Console and retry. (Probe 3 in `VERIFY.md` only verifies the
local-app side of the handshake; it cannot exercise Google's
checks without a real user consent.)

## Follow-ups committed for future iterations

- M6.3.1 re-marked as fully complete (live OAuth start is
  functional, not just `/healthz`). Update `.autodev/PLAN.md`
  inline in the next iteration's log.
- Sidecar tier (M7.0.2 and beyond) will inherit the same env-only
  pattern when it ships; not in scope here.
- If/when `DATABASE_URL` is wired into the live control plane,
  extend `deploy/VERIFY.md` with a DB probe and push the secret
  in the same `flyctl secrets set` call so the rolling restart
  picks it up atomically.

## Files touched

- `apps/web/src/lib/server/oauthConfig.ts` — env-first, dev-only
  file fallback gated on `NODE_ENV !== "production"`.
- `deploy/VERIFY.md` — new file: post-deploy probe set.
- Fly: `flyctl secrets set` (5 secrets) + `flyctl deploy`. Image
  digest `registry.fly.io/tex-center:deployment-01KRC3AKBBT8R1DYDVT2NZNR52`.

## Tests

`bash tests_normal/run_tests.sh` — 72 passing, ~65s. The
refactored `oauthConfig.ts` has no direct unit-test today (env +
disk side-effects); the existing `oauthStart.test.mjs` and
`oauthCallback.test.mjs` exercise the pure builder and parser
downstream of it. A targeted unit test for `loadOAuthConfig`'s
env-vs-file precedence is a candidate FUTURE_IDEAS entry but
would need a temp-dir + env-stash harness that isn't in
`tests_normal/lib.sh` yet.
