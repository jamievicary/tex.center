# tex.center — Plan

## Overview

Build a cloud LaTeX editor (Overleaf-like) on top of `vendor/supertex`,
with edit-to-preview latency in the 100s of ms via supertex's
checkpoint/resume + incremental PDF wire format. MVP: white sign-in
page, Google OAuth gated to `jamievicary@gmail.com`, three-panel
editor (file tree / CodeMirror 6 / PDF.js), per-project Fly Machine
running supertex as a daemon, control-plane Fly Machine for auth +
routing, Postgres + Tigris for state, CD from `main`. Live at
https://tex.center.

## Milestones

Roughly: (A) vertical slice runnable locally end-to-end, (B)
supertex daemon-isation, (C) Fly deployment + per-project Machine
spawning, (D) auth + production polish.

- [x] **M0 — Repo scaffolding** _(iter 2–3)_
- [x] **M1 — Static frontend shell** _(iter 4)_ — SvelteKit, runes,
      `/` white sign-in page, `/editor` three-panel grid.
- [x] **M2 — Sidecar service skeleton** _(iter 5–6)_ — Fastify +
      `ws`, in-memory Yjs, "viewing page N" channel, fixture
      compile loop; `packages/protocol` wire format; browser
      `WsClient` + `PdfBuffer`; `y-codemirror.next` binds CM6.

- [~] **M3 — supertex compile path.** Real engine today is
      `SupertexOnceCompiler` (per-edit spawn of
      `supertex --once --output-directory`). Streaming/daemon variant
      tracked as M7.5. `SIDECAR_COMPILER` env-var: `fixture` (dev/unit)
      vs `supertex` vs `supertex-daemon` (production default since
      iter 123).

- [~] **M4 — Persistence.** Postgres (Drizzle) for entities;
      Tigris (S3) for blobs.
      - [x] M4.0–M4.2.2 — Schema, tables, migration loader, PGlite
            gold test, `app.db` wiring. _(iter 16–19, 23.)_
      - [~] **M4.3 — Project hydration.**
            - [x] M4.3.0 — `packages/blobs`: `BlobStore` interface +
                  `LocalFsBlobStore`. _(iter 24)_
            - [ ] M4.3.1 — `S3BlobStore` against AWS SDK; gold-test
                  against MinIO once docker-compose lands
                  (`FUTURE_IDEAS.md`). `health()` = HeadBucket.
            - [~] M4.3.2 — Sidecar wiring. Source-file half done
                  (iter 28–30). Checkpoint persistence waits for M7.4.2
                  (no upstream serialise wire yet).

- [x] **M5 — Auth.** Google OAuth (Auth Code + PKCE), JWKS verify,
      server-side sessions, allowlist `jamievicary@gmail.com`.
      _(iter 32–39, 47–49.)_ Pure `packages/auth` (HMAC tokens, PKCE);
      `apps/web` start/callback/logout routes; `hooks.server.ts`
      injects `event.locals.session`; `/editor` redirects unauth to
      `/`. Session sweeper storage primitive
      `deleteExpiredSessions` landed iter 54; scheduling deferred to
      FUTURE_IDEAS.

- [x] **M6 — Fly deploy: control plane.** _(iter 42–46, 73, 76.)_
      `apps/web/Dockerfile`, `fly.toml`, GitHub Actions deploy,
      `/healthz`, custom domain `tex.center` via Cloudflare apex
      reconciliation (`scripts/cloudflare-dns.mjs`), Fly cert via
      TLS-ALPN-01, OAuth secrets via env-first `oauthConfig.ts`.
      See `deploy/README.md` + `deploy/VERIFY.md`.

- [~] **M7 — Sidecar + per-project Machines.**
      - [x] **M7.0** — Single shared sidecar Machine.
            - M7.0.0 — `apps/sidecar/Dockerfile` multi-stage. _(iter 74)_
            - M7.0.1 — Patched lualatex engine vendored at
              `vendor/engine/x86_64-linux/lualatex-incremental`
              (provenance `jamievicary/luatex-incremental@aa053dd-dirty`;
              see `vendor/engine/README.md`). _(iter 75, 87–88)_
            - M7.0.2 — `apps/sidecar/fly.toml` + Fly app
              `tex-center-sidecar` in `fra` (6PN-only, port 3001).
              Canonical deploy: `flyctl deploy --remote-only
              --no-public-ips -a tex-center-sidecar
              --config apps/sidecar/fly.toml .` (pass **both** `-a`
              and `--config`). _(iter 87, 93)_
            - M7.0.3 — Control-plane WS proxy
              `apps/web/src/lib/server/wsProxy.ts` (byte-level
              forwarder, hooks `http.Server` 'upgrade'); custom Node
              entry `server.ts`/`boot.ts` built via
              `scripts/build-server-entry.mjs`; SIGTERM/SIGINT 10s
              hard-stop. _(iter 94–97)_

      - [x] **M7.1** — Machines API client + per-project Machines.
            - M7.1.0 — `apps/web/src/lib/server/flyMachines.ts`:
              `MachinesClient` with `create/get/start/stop/destroy/
              waitForState`; internal 6PN form
              `<id>.vm.<app>.internal`. _(iter 99)_
            - M7.1.1 — `packages/db/src/machineAssignments.ts` on the
              existing `machine_assignments` table. _(iter 102)_
            - M7.1.2 — `upstreamResolver.ts` with full state machine +
              per-projectId promise dedup; `upstreamFromEnv.ts` wired
              in `server.ts` gated on `FLY_API_TOKEN` +
              `SIDECAR_APP_NAME` + `SIDECAR_IMAGE`.
              `MachineConfig` carries `auto_destroy: false`,
              `restart: on-failure`. _(iter 103–104)_
            - M7.1.3 — Fly Postgres `tex-center-db` attached;
              migration-on-boot via `bootMigrations.ts`; live deploy
              with secrets set; authed live probes pass. _(iter 105–109)_
              **Token caveat**: control plane uses
              `creds/fly.token` (personal). Narrower deploy-scoped
              token in FUTURE_IDEAS.
            - M7.1.4 — Idle-stop wiring. `buildServer` tracks global
              viewer count, arms timer on zero-transition. Entry
              point reads `SIDECAR_IDLE_TIMEOUT_MS` (default 600_000,
              `0` disables) and wires `onIdle` to clean exit.
              Combined with `restart: on-failure`, Machine ends up
              `stopped`; `upstreamResolver.ts` wakes it on next WS
              upgrade. Closes M7.3. _(iter 118)_

      - [x] **M7.2** — `/ws/project/<id>` routing per project.
            - M7.2.0 — Per-project access gate at WS upgrade
              (`makeProjectAccessAuthoriser` in `wsAuth.ts`;
              `lookupProjectOwner(projectId)` admits only owner).
              _(iter 138)_
            - M7.2.1 — 401 vs 403 discrimination via
              `UpgradeAuthDecision = { kind: "allow" | "deny-anon"
              | "deny-acl" }`; missing project → `deny-acl` (hide
              existence); owner-lookup throws → `deny-acl` (don't
              re-auth on transient DB hiccup). _(iter 139)_

      - [x] **M7.3** — ~10-min idle auto-stop. _(Folded into M7.1.4)_

      - [~] **M7.4** — Checkpoint blob protocol on the compiler
            interface; persist on idle-stop, rehydrate on wake.
            Closes M4.3.2 tail.
            - [x] M7.4.0 — Interface contract +
                  `Compiler.snapshot()/restore()` no-op impls;
                  `persistence.ts` checkpoint helpers. _(iter 119)_
            - [x] M7.4.1 — Sidecar wiring: `ensureRestored(p)` lazy
                  per project before `compile()`;
                  `persistAllCheckpoints()` on idle-timer fire.
                  Today every concrete `snapshot()` returns null so
                  end-to-end behaviour is unobservable; pinned by
                  `serverCheckpointWiring.test.mjs`. _(iter 120)_
            - [ ] **M7.4.2** — Upstream supertex daemon
                  serialise/restore wire (candidate item 2), then
                  real `SupertexDaemonCompiler.snapshot/restore`.
                  M7.4.2 gates checkpoint persistence ever doing
                  anything observable in prod.

      - [x] **M7.5** — Supertex `--daemon DIR` adoption (upstream
            landed via discussion 71).
            - M7.5.0 — Bump `vendor/supertex` to `c571420`. _(iter 90)_
            - M7.5.1 — `daemonProtocol.ts`: line types `[N.out]`,
              `[rollback K]`, `[error <reason>]`, `[round-done]`.
              _(iter 91)_
            - M7.5.2 — `SupertexDaemonCompiler` persistent process,
              lazy spawn on first `compile()`, graceful close ladder.
              _(iter 107)_
            - M7.5.3 — `[error <reason>]` → `compile-status` wire.
            - M7.5.4 — Deleted `pdfStabilityWatcher.ts`; daemon
              consumes `[round-done]` as stability signal. _(iter 115)_
            - M7.5.5 — Integration tests against the fake daemon
              (`supertexDaemonCompiler.test.mjs`). Iter 121 fixed
              0/1-indexing mismatch (chunks emit `[1.out]`…). Iter 122
              added standing real-ELF gold test
              (`tests_gold/lib/test/supertexDaemonReal.test.mjs`),
              self-skips if binary or `lualatex` absent.

- [~] **M8 — Acceptance pass + Playwright (pulled forward).**
      - [x] M8.pw.0 — Playwright skeleton. _(iter 78)_
            `tests_gold/setup_playwright.sh` DrvFs-aware install;
            `playwright.config.ts` with `local`/`live` projects.
      - [x] M8.pw.1 — Session-cookie injection + authed surface.
            `mintSession` helper, `flyProxy.ts`, `authedPage`
            fixture; `local` uses PGlite-over-TCP. _(iter 79, 82–86)_
      - [x] M8.pw.2 — Deploy-iteration verification.
            `verifyLive.spec.ts` encodes the five `VERIFY.md` probes.
            Canonical: `TEXCENTER_LIVE_TESTS=1
            bash tests_gold/run_tests.sh`. _(iter 98)_
      - [ ] **M8.acceptance** — Walk the seven `GOAL.md` acceptance
            criteria end-to-end on prod, fix gaps. Real OAuth
            consent-screen driving stays out of scope (HTTP-handshake
            check + cookie-injection authed tests cover the same
            surface).

## Priority block (iter 131, discussion-revised)

Two production-down OAuth-callback bugs in 24h motivated this block:
the verification surface — `verifyLive.spec.ts` + cookie-injected
authed probes — left the full callback path untested. See
`.autodev/discussion/131_{question,answer}.md` for the full
diagnosis.

- [x] **M8.smoke.0** — `scripts/smoke-runtime-image.sh` + `smoke`
      job in `.github/workflows/deploy.yml` (deploy now
      `needs: smoke`). Probes eight endpoints; flags
      `ERR_MODULE_NOT_FOUND` / unexpected 5xx. Structural
      invariants pinned by
      `tests_normal/cases/test_deploy_workflow.py`. _(iter 132)_
- [~] **M8.pw.3** — Real OAuth round-trip via a dedicated Google
      service account with the OAuth client pre-consented. Test
      obtains an ID token (refresh-token grant) and presents it to
      a test-only callback finaliser endpoint with a bypass-key
      header, exercising the same code path as the real callback
      post-token-exchange.
      - [x] M8.pw.3.0 — Extract `finalizeGoogleSession` from
            `resolveGoogleCallback` (`oauthCallback.ts`). _(iter 133)_
      - [x] M8.pw.3.1 — `POST /auth/google/test-callback` gated on
            `TEST_OAUTH_BYPASS_KEY`; HMAC-SHA256 `X-Test-Bypass`
            header; pure orchestrator `testOauthCallback.ts:
            resolveTestCallback`. _(iter 134)_
      - [x] M8.pw.3.2 — `scripts/google-refresh-token.mjs` one-shot
            helper +
            `tests_gold/lib/src/mintGoogleIdToken.ts` (refresh-
            token-grant). _(iter 135)_
      - [x] M8.pw.3.3 — `verifyLiveOauthCallback.spec.ts`: mints
            ID token, POSTs to `/auth/google/test-callback`,
            asserts `302 → /projects` + cookie, GETs `/projects`
            authed → 200; cleans up session row in `try/finally`.
            **Live activation pending operator step** (see
            "Live activation" below). _(iter 136)_
- [~] **M8.pw.4** — Full product-loop spec
      `tests_gold/playwright/verifyLiveFullPipeline.spec.ts`
      (iter 137): live-only, additionally gated on
      `TEXCENTER_FULL_PIPELINE=1`. Seeds project, types into CM,
      listens for binary `pdf-segment` WS frames (tag `0x20`),
      asserts PDF.js rendered ≥1 non-near-white pixel. 5-min
      timeout for cold-start. Subsumes M8.acceptance.
      **Live activation pending** export of
      `TEXCENTER_FULL_PIPELINE=1`.

### Live activation (operator-gated, code-side done)

- **M8.pw.3.3** — create the test OAuth client in GCP with
  `http://localhost:4567/oauth-callback` registered, save as
  `creds/google-oauth-test.json`; run `pnpm exec node
  scripts/google-refresh-token.mjs` once to capture
  `creds/google-refresh-token.txt`; `openssl rand -hex 32` →
  `flyctl secrets set TEST_OAUTH_BYPASS_KEY=<key> -a tex-center`
  + export the same value in the live runner shell.
- **M8.pw.4** — export `TEXCENTER_FULL_PIPELINE=1` alongside the
  existing `TEXCENTER_LIVE_TESTS=1` + authedPage env. No deploy
  step.

Until these activate, both specs self-skip on every `live` run.

## Current focus

**Next ordinary iteration:** M7.4.2 — upstream supertex daemon
serialise/restore wire (candidate item 2 below), then real
`SupertexDaemonCompiler.snapshot/restore`. With M7.4.1 landed, the
sidecar half is fully wired: the day a real `snapshot()` returns
non-null, persistence is automatic.

The CD workflow `.github/workflows/deploy-sidecar.yml` (iter 124)
is path-gated on `apps/sidecar/**`, `vendor/supertex`,
`vendor/engine/**`, the shared `packages/*` the sidecar depends
on, lockfile, workspace, and the workflow file itself; plus
`workflow_dispatch`. Structural invariants pinned by
`tests_normal/cases/test_deploy_sidecar_workflow.py`.

The `verifyLiveWsUpgrade` spec still needs `TEXCENTER_LIVE_TESTS=1`
+ `FLY_API_TOKEN` + `SIDECAR_APP_NAME` in the env to run against
prod — first deploy-touching iteration that does so will exercise
it end-to-end.

## Live caveats

- Production default is `SIDECAR_COMPILER=supertex-daemon` (iter
  123); takes live effect on next sidecar deploy.
- `app.db` only powers `/healthz` (`SELECT 1`, reports `db: { state }`).
  Same endpoint reports `blobs: { state }` via `BlobStore.health()`;
  future S3 adapter must implement it. `/healthz` is intentionally a
  liveness probe — `/readyz` candidate in FUTURE_IDEAS.
- Persistence is one-shot per session: permanent blob outage means
  edits this process are never persisted. Acceptable in the
  per-project Machine model where Machines cycle frequently.

## Local toolchain

Node 20.18.1 auto-provisioned per-checkout into `.tools/node/`
(gitignored) by `tests_normal/setup_node.sh`. Runner then calls
`pnpm install --frozen-lockfile --prefer-offline` and `pnpm -r
typecheck`. pnpm via corepack at the version pinned in root
`package.json#packageManager`.

**DrvFs (/mnt/c) workaround.** WSL2 mounts of the Windows filesystem
can't host pnpm's atomic-rename install reliably. `setup_node.sh`
detects `/mnt/*` checkouts, stashes `node_modules/` under
`~/.cache/tex-center-nm/<sha1-of-checkout-path>/node_modules` (ext4),
and symlinks back. `node-linker=hoisted` (in repo `.npmrc`) keeps the
layout flat enough for Node's resolver to walk the realpath correctly.

## Open questions / risks

- **Checkpoint blob size and Tigris round-trip.** Cold-start Machine
  must restore in seconds for the second-visit UX. Measure early in M7.4.
- **Fly Machine cold start vs the 100s-of-ms target.** Latency goal
  applies once warm; cold start needs a UI affordance.
- **Yjs for single-user MVP** is over-engineered, but rewriting for
  collab later is worse. Keeping it.
- **Test strategy.** `tests_normal/` = fast unit + type checks;
  `tests_gold/` = end-to-end (Playwright) + real-supertex compile
  tests. Gold needs a docker-compose bring-up for the S3 path
  (FUTURE_IDEAS).

## Candidate supertex (upstream) work

PRs against `github.com/jamievicary/supertex`.

1. ~~`--daemon DIR` mode.~~ **Landed upstream** (discussion 71).
   Sidecar adoption M7.5.
2. **Checkpoint serialise/restore to a single blob.** (M7.4.2)
