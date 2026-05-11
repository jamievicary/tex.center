# Live deployment is in scope, starting now

## Reset on scope

`GOAL.md` has been amended (see the new opening paragraph of
`## MVP scope` and the new opening paragraph of
`## External services & credentials`) to make explicit what was
always implied: **achieving a live, continuously-deployed service
at https://tex.center is the goal of this project, and doing so
end-to-end is your job** — running `flyctl`, `gh`, and the
Cloudflare API against live services using the credentials in
`creds/`. This is not "out-of-tree" work, despite the language
PLAN.md has accumulated over the last 25 iterations. PLAN.md's
framing of M6.3.1 and M7 as "out-of-tree one-shots that run
outside autodev" is wrong and should be corrected.

Re-read `GOAL.md` in full before the next iteration. Then update
`.autodev/PLAN.md` to reflect this: M6.3.1 is a normal in-scope
iteration; M7 is a normal in-scope milestone; the "out-of-tree"
vocabulary should be removed.

## Credentials available

All four are present in `creds/` (gitignored), and you may use them:

- `creds/fly.token` — Fly.io API token. Use with `flyctl` by
  exporting `FLY_API_TOKEN=$(cat creds/fly.token)` in the
  iteration's shell. Authorised for: creating the `tex-center`
  app, deploying it, provisioning Postgres, provisioning Tigris,
  setting Fly secrets, creating per-project Machines, allocating
  IPs, creating certs.
- `creds/cloudflare.token` — Cloudflare API token with DNS edit
  on the `tex.center` zone. Use via `curl` against the Cloudflare
  v4 API, or by passing it to `scripts/cloudflare-dns.mjs` (the
  reconciler landed iter 46) via the documented CLI flags.
- `creds/github.token` — GitHub PAT with `repo` and `workflow`
  scope. Use with `gh` after exporting
  `GH_TOKEN=$(cat creds/github.token)`. Authorised for: setting
  Actions secrets (`gh secret set FLY_API_TOKEN`), pushing
  branches, opening / merging PRs on
  `github.com/jamievicary/tex.center`.
- `creds/google-oauth.json` — Google OAuth client credentials.
  The redirect URI for production
  (`https://tex.center/auth/google/callback`) must be configured
  in the Google Cloud Console; Google's API does not let you
  fully self-serve that, so if and only if you need to add the
  prod redirect URI and discover it is missing, surface the
  exact instruction the user needs to perform — otherwise treat
  these credentials as ordinary configuration.

## Immediate work

The next ordinary iteration should land M6.3.1 against live
services:

1. `flyctl apps create tex-center` (region `fra` per `fly.toml`).
2. `gh secret set FLY_API_TOKEN < creds/fly.token` on
   `github.com/jamievicary/tex.center` so the existing
   `.github/workflows/deploy.yml` (iter 44) can run.
3. Trigger the first deploy — either by pushing a no-op commit
   to `main` or by running `flyctl deploy --remote-only` directly
   from the iteration.
4. `flyctl ips allocate-v4` / `allocate-v6` on the app; capture
   the assigned addresses.
5. `flyctl certs create tex.center` and capture the ACME DNS-01
   challenge name + value.
6. Run `scripts/cloudflare-dns.mjs` with the captured IPs and
   the ACME challenge to upsert the apex `A`/`AAAA` records and
   the `_acme-challenge` TXT record. Wait for the cert to issue
   (`flyctl certs show tex.center` until status is `Ready`).
7. Probe `https://tex.center/healthz` and confirm a 200; probe
   `https://tex.center/` and confirm the white sign-in page
   renders.
8. Commit any state that needs to live in the repo (e.g. captured
   IPs in a `deploy/` doc, app metadata, etc.) — but never the
   raw tokens.

Treat any failure mode here as ordinary iteration work: diagnose,
fix, retry. If you hit a Fly / Cloudflare error you cannot
resolve from the API alone (e.g. an org-level quota), surface it
with the exact command + response and ask the user to intervene
— but only after exhausting the API path.

## After M6.3.1

The follow-on milestone is M7 — per-project Fly Machines. That,
too, is in-scope autodev work, not "out-of-tree":

- Build the TeX-Live + supertex container image (the
  `apps/sidecar` Dockerfile does not yet exist).
- Push it to Fly's registry.
- Implement the Machines-API client in the control plane (spawn,
  wake, idle-stop, destroy).
- Wire the control plane's WebSocket layer to route
  `/ws/project/<id>` to the project's Machine.
- Persist checkpoint blobs to Tigris on idle-stop; rehydrate on
  wake.

Decompose M7 into sub-milestones in PLAN.md and start working
through them. The smallest useful intermediate target — and the
one that closes the "useful MVP" gap fastest — is a **single
shared sidecar Machine** carrying TeX Live + supertex, deployed
alongside the control plane, with the control plane proxying all
project WS traffic to it. This is not the final architecture
(per-project Machines per GOAL.md), but it is the smallest
deployable thing that makes the live site actually compile
LaTeX. Ship it as M7.0 and iterate toward per-project from
there.
