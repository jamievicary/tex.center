# Production OAuth is broken: secrets aren't in the deployed image

## Symptom

The user clicked "Sign in with Google" on the live site and saw:

> Server misconfigured: Cannot read Google OAuth credentials
> from `/app/creds/google-oauth.json`: ENOENT: no such file or
> directory, open '/app/creds/google-oauth.json'. Create the file
> with `{"client_id": "...", "client_secret": "..."}`.

## Root cause

`creds/` is gitignored (see `.gitignore`: `creds/`, `*.token`)
and almost certainly `.dockerignore`d too (verify: read
`apps/web/.dockerignore`). The deployed image therefore does not
contain `creds/google-oauth.json`, even though the local-dev
path reads it from disk. This was missed during M6.3.1 because
the iter-73 verification step only probed `/healthz` and `/`,
not the OAuth flow.

This is **not** a "ship `creds/` into the image" problem. Doing
so would push secrets into the Fly registry, which is a leak
vector — anyone with read access to the org's images (including
future contractors, CI runners, accidental public images) would
see the OAuth client secret. Secrets must come from Fly secrets
(injected as env vars at runtime), not from the image.

## Required changes

### 1. Refactor the OAuth credential loader

Find the call site reading `/app/creds/google-oauth.json` (likely
`apps/web/src/lib/server/oauthConfig.ts` or similar; grep for the
error string and `google-oauth.json`). Change it to read from
environment variables — `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` — with a clear "missing env var" error
rather than a file-not-found error.

For local dev, the cleanest path is to keep the env-var contract
and have a small dev helper that exports them from
`creds/google-oauth.json` when starting the dev server (e.g. an
`apps/web/.env.local` written by a dev script, or a `pnpm dev`
wrapper that reads the JSON and exports before invoking
`vite dev`). The file-fallback should not survive in the
production code path — it caused this incident and will cause
others.

### 2. Audit every other secret the app reads

Open the apps/web server tier and the sidecar and grep for every
config/secret read. At minimum:

- `SESSION_SIGNING_KEY` — must be a long random value in
  production, distinct from any local-dev default.
- `DATABASE_URL` — Postgres connection string for production
  (Fly Postgres; iter-73 may or may not have provisioned this).
  Verify against the live app: does
  `https://tex.center/healthz` report DB up or absent?
- Any other `creds/*` references.

Each one needs the same treatment: read from env in production,
hydrate from `creds/` only via a local-dev shim.

### 3. Push the secrets to Fly

```
export FLY_API_TOKEN=$(cat creds/fly.token)
flyctl secrets set \
  GOOGLE_CLIENT_ID="$(jq -r .client_id creds/google-oauth.json)" \
  GOOGLE_CLIENT_SECRET="$(jq -r .client_secret creds/google-oauth.json)" \
  SESSION_SIGNING_KEY="$(openssl rand -hex 32)" \
  --app tex-center
```

If `DATABASE_URL` also needs to be set (or any other env), include
it in the same `flyctl secrets set` call so the rolling restart
picks them all up at once.

### 4. Verify end-to-end against the live site

Treat this as part of the iteration, not a follow-up:

- After `flyctl secrets set`, wait for the rolling restart
  (`flyctl status --app tex-center` until machines are `started`
  on the new release).
- Probe `https://tex.center/auth/google/start` with `curl -i`
  and confirm it 302-redirects to `accounts.google.com/...`
  (not a 500).
- Manually surface to the user that the OAuth redirect URI
  `https://tex.center/auth/google/callback` must be present in
  the Google Cloud Console's "Authorized redirect URIs" for the
  OAuth client. The Google Console doesn't permit full
  self-serve from the API for this, so if `curl`ing the
  Google-Authorize URL returns an `redirect_uri_mismatch` error
  page after step 3, this is the next thing the user needs to
  fix manually. (Per GOAL.md §External services & credentials,
  this is one of the few items where surfacing an instruction to
  the user is the correct move.)

### 5. Commit a verification artefact

Add a small `deploy/VERIFY.md` (or extend whatever you started
in M6.3.1) describing the exact `curl` probes that prove the
live site's OAuth start endpoint is functional. Future
deploy-touching iterations should re-run those probes before
declaring success — same idea as PdfStabilityWatcher's
"stability is the round-done signal", applied to deploys.

## Why this is M6.3.1 in spirit, not a new milestone

M6.3.1's stated goal is "the live site at https://tex.center
works" — implicitly, the login flow works, not just that
unauth-`/` serves a white page. The iter-73 verification was
incomplete. This iteration is closing that gap, not adding new
scope.
