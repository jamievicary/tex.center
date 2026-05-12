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
      vs `supertex` (production). `awaitPdfStable` watcher (iter 41)
      deleted iter 115 — neither compile path needs it (once exits
      cleanly, daemon emits `[round-done]`).

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
                  (iter 28–30): `buildServer` accepts `blobStore?`;
                  hydration into `Y.Text`; `writeMain` persists via
                  `persistence.ts` gated by `canPersist`. Checkpoint
                  persistence waits for M7.4 (no checkpoint-blob
                  protocol yet).

- [x] **M5 — Auth.** Google OAuth (Auth Code + PKCE), JWKS verify,
      server-side sessions, allowlist `jamievicary@gmail.com`.
      _(iter 32–39, 47–49.)_ Pure `packages/auth` (HMAC tokens, PKCE);
      `apps/web` start/callback/logout routes; `hooks.server.ts`
      injects `event.locals.session`; `/editor` redirects unauth to
      `/`. JWKS 60s `clockTolerance`. OAuth `access_denied` → `/`.
      Session sweeper storage primitive `deleteExpiredSessions` landed
      iter 54; scheduling deferred to FUTURE_IDEAS.

- [~] **M6 — Fly deploy: control plane.**
      - [x] M6.0–M6.2.1 — `apps/web/Dockerfile`, `fly.toml`,
            GitHub Actions deploy, `/healthz`. _(iter 42–45.)_
      - [x] M6.3 — Custom domain `tex.center` via Cloudflare.
            `scripts/cloudflare-dns.mjs` reconciler (iter 46);
            live deploy (iter 73, 76): `tex-center` in `fra`, shared
            IPv4 + dedicated IPv6, Cloudflare apex reconciled, Fly
            cert via TLS-ALPN-01, OAuth secrets via env-first
            `oauthConfig.ts`. See `deploy/README.md` +
            `deploy/VERIFY.md`.

- [~] **M7 — Sidecar + per-project Machines.**
      - [~] **M7.0** — Single shared sidecar Machine (deployable cut
            so the live site compiles LaTeX).
            - [x] M7.0.0 — `apps/sidecar/Dockerfile` multi-stage +
                  structural test. _(iter 74)_
            - [x] M7.0.1 — Provision patched lualatex engine. Route (b):
                  prebuilt stripped ELF vendored at
                  `vendor/engine/x86_64-linux/lualatex-incremental`
                  (7.3 MB, glibc ≤ 2.34, runs on bookworm). Runtime
                  installs wrapper `/opt/engine/bin/lualatex-incremental`,
                  dumps `lualatex.fmt` in cacheable layer.
                  `TEXMFCNF=/etc/texmf/web2c:/usr/share/texlive/texmf-dist/web2c`
                  set after apt-install RUN. Provenance:
                  `jamievicary/luatex-incremental@aa053dd-dirty`; see
                  `vendor/engine/README.md`. _(iter 75, 87–88.)_
            - [x] M7.0.2 — `apps/sidecar/fly.toml` + Fly app
                  `tex-center-sidecar` in `fra` (6PN-only, no public
                  IPs, port 3001). _(iter 87, 93.)_ Canonical deploy:
                  `flyctl deploy --remote-only --no-public-ips
                  -a tex-center-sidecar --config apps/sidecar/fly.toml .`
                  (always pass **both** `-a` and `--config`).
            - [x] M7.0.3 — Control-plane WS proxy. _(iter 94–97.)_
                  Pure proxy module `apps/web/src/lib/server/wsProxy.ts`
                  (byte-level forwarder, hooks `http.Server` 'upgrade',
                  validates pathname `/^[A-Za-z0-9_-]+$/`, no `ws` dep);
                  custom Node entry `server.ts`/`boot.ts` built via
                  `scripts/build-server-entry.mjs` (esbuild); SIGTERM/SIGINT
                  10s hard-stop; optional `authoriseUpgrade(req)` hook
                  (`wsAuth.ts` adapts `resolveSessionHook`); live probes
                  pass for 401/404. Happy-path probe folded into M7.1.3.2.

      - [~] **M7.1** — Machines API client in the control plane:
            spawn, wake, idle-stop, destroy. Replace the shared sidecar
            with on-demand per-project Machines.
            - [x] M7.1.0 — `apps/web/src/lib/server/flyMachines.ts`:
                  `MachinesClient` with `create/get/start/stop/destroy/
                  waitForState`; pure helpers; internal 6PN form
                  `<id>.vm.<app>.internal`. _(iter 99.)_
            - [x] M7.1.1 — DB primitives for project↔machine mapping
                  (`packages/db/src/machineAssignments.ts`) on the
                  existing `machine_assignments` table. `app_name` left
                  ambient (env-driven) — single sidecar app for MVP;
                  promote to a column if multi-app routing lands.
                  _(iter 102.)_
            - [x] M7.1.2 — Per-project upstream resolver.
                  - M7.1.2.0: `upstreamResolver.ts` with full state
                    machine + per-projectId promise dedup;
                    `WsProxyOptions.upstream` widened to factory;
                    resolution after auth gate; resolver throw → 502.
                    _(iter 103.)_
                  - M7.1.2.1: wired in `server.ts` gated on
                    `FLY_API_TOKEN` + `SIDECAR_APP_NAME` + `SIDECAR_IMAGE`;
                    static-envvar fallback. `upstreamFromEnv.ts` with
                    injectable deps for unit tests. `MachineConfig`
                    carries `auto_destroy: false`, `restart: on-failure`;
                    `SIDECAR_PORT=3001`, `SIDECAR_REGION=fra` defaults.
                    _(iter 104.)_
            - [~] M7.1.3 — `DATABASE_URL` + `FLY_API_TOKEN` secrets on
                  control plane; deploy; happy-path authed probes.
                  - [x] M7.1.3.0 — Migration-on-boot helper
                        (`bootMigrations.ts`); Dockerfile copies
                        `packages/db/src/migrations/` to `/app/migrations`.
                        _(iter 105.)_
                  - [x] M7.1.3.1 — Provision Fly Postgres (`tex-center-db`,
                        unmanaged single-node `shared-cpu-1x` in `fra`),
                        attached to `tex-center` (auto-set `DATABASE_URL`),
                        secrets set (`RUN_MIGRATIONS_ON_BOOT=1`,
                        `FLY_API_TOKEN`, `SIDECAR_APP_NAME`,
                        `SIDECAR_IMAGE=<digest>`), deployed. Sidecar
                        Dockerfile fixed iter 107 (`make … all`,
                        `SUPERTEX_BIN=…/supertex`); redeployed iter 108
                        with `sha256:cf00052c…`; ssh-probe confirms
                        `supertex --once` produces a 56 KB `main.pdf`.
                        _(iter 106–108.)_ **Token caveat**:
                        `flyctl tokens create deploy` denied for personal
                        token scope; control plane uses
                        `creds/fly.token`. Narrower deploy-scoped token
                        is a hardening follow-up (FUTURE_IDEAS).
                  - [~] M7.1.3.2 — Authed deploy-verification probes.
                        - [x] M7.1.3.2.a — Rotated `SESSION_SIGNING_KEY`
                              (live), seeded live user row, saved to
                              `creds/{session-signing-key,live-user-id}.txt`,
                              added `scripts/seed-live-user.mjs` +
                              `verifyLiveAuthed.spec.ts` (authed
                              `/projects` 200; anon `/projects` 302 → `/`).
                              7/7 live probes pass. _(iter 109.)_
                        - [~] M7.1.3.2.b — WS-upgrade-with-cookie probe
                              asserting upgrade → 101 from a real
                              per-project Machine.
                              - [x] M7.1.3.2.b.0 — Teardown helper
                                    `tests_gold/lib/src/cleanupProjectMachine.ts`:
                                    composes `MachinesClient.destroyMachine`
                                    + `deleteMachineAssignment`; 404 from
                                    destroy is "already gone" (success);
                                    non-404 propagates and preserves the
                                    row so the next iteration can retry.
                                    Duck-typed interfaces keep it free of
                                    an `apps/web` import. Unit-tested via
                                    `cleanupProjectMachine.test.mjs`
                                    (happy / no-assignment / 404 / 500).
                                    _(iter 116.)_
                              - [x] M7.1.3.2.b.1 — `verifyLiveWsUpgrade.spec.ts`
                                    drives an `https.request` WS upgrade against
                                    `/ws/project/<projectId>` with a minted
                                    `tc_session` cookie and asserts the
                                    `'upgrade'` event fires with status 101.
                                    Test-level try/finally runs
                                    `cleanupProjectMachine` (inline
                                    `MachineDestroyer` against
                                    `api.machines.dev` + drizzle-backed
                                    `AssignmentStore`), deletes the project
                                    row, and deletes the session. Live-only
                                    (skips on `local`); further self-skip on
                                    missing `FLY_API_TOKEN` /
                                    `SIDECAR_APP_NAME`. `test.setTimeout`
                                    raised to 5 min for cold-start. Closes
                                    M7.0.3.3 tail. _(iter 117.)_
                        - [x] M7.1.3.2.c — Prerender bug on `/`.
                              `+layout.ts` no longer defaults
                              `prerender = true`; every concrete page
                              (`/`, `/projects`, `/editor/[projectId]`)
                              owns its own `+page.ts` with
                              `prerender = false`, so the
                              `routeRedirect` hook fires on production
                              GETs of `/`. Regression guarded by
                              `test_landing_sign_in.test_prerender_disabled`.
                              _(iter 112.)_
            - [x] M7.1.4 — Idle-stop wiring on per-project Machine side.
                  `buildServer` accepts `idleTimeoutMs` + `onIdle`; tracks
                  global viewer count and arms a `setTimeout` only on the
                  zero-transition (cancelled by next connection). Entry
                  point reads `SIDECAR_IDLE_TIMEOUT_MS` (default 600_000,
                  `0` disables) and wires `onIdle` to
                  `app.close().then(() => process.exit(0))`. Combined with
                  the per-project Machine `restart: on-failure` policy
                  set in `upstreamFromEnv.ts`, a clean exit leaves the
                  Machine `stopped`; `upstreamResolver.ts:139-141` wakes
                  it on the next WS upgrade. Closes M7.3. _(iter 118.)_
      - [ ] **M7.2** — `/ws/project/<id>` routing per project.
      - [x] **M7.3** — ~10-min idle auto-stop. _(Folded into M7.1.4
            iter 118; see above.)_
      - [~] **M7.4** — Checkpoint blob protocol on the compiler
            interface; persist on idle-stop, rehydrate on wake.
            Closes M4.3.2 tail.
            - [x] M7.4.0 — Interface contract + no-op impls.
                  `Compiler` gains `snapshot(): Promise<Uint8Array | null>`
                  and `restore(blob): Promise<void>`. All three
                  compilers implement as no-ops today (no upstream
                  serialise wire). `persistence.ts`:
                  `projectCheckpointKey` (lives at
                  `projects/<id>/checkpoint.bin`, outside `files/`),
                  `persistCheckpoint` (null/empty → no-op),
                  `loadCheckpoint` (missing/empty → null).
                  `checkpointBlob.test.mjs` pins the contract.
                  _(iter 119.)_
            - [x] M7.4.1 — Sidecar wiring. _(iter 120.)_
                  `buildServer`:
                    - `ensureRestored(p)` — lazy, idempotent per
                      project; awaits `loadCheckpoint` then
                      `compiler.restore(blob)` if non-null; runs
                      inside `runCompile` after `awaitHydrated` and
                      before `compile()`. Errors logged + swallowed
                      (next compile rebuilds from scratch — matches
                      the documented `restore()` fallback).
                    - `persistAllCheckpoints()` — iterates projects,
                      `compiler.snapshot()` → `persistCheckpoint`.
                      Wired into the idle-timer fire so it runs
                      before the user's `onIdle` (the entry point's
                      onIdle calls `app.close()`, which destroys
                      per-project state). Per-project failures
                      logged, do not abort the rest.
                  Today every concrete `snapshot()` returns null so
                  end-to-end behaviour is unobservable; wiring
                  pinned by `serverCheckpointWiring.test.mjs` with a
                  `RecordingCompiler` (seed→restore, null-snapshot
                  no-op, snapshot bytes land in the blob store
                  before user's onIdle fires).
            - [ ] M7.4.2 — Upstream supertex daemon serialise/restore
                  wire (PLAN candidate item 2), then real
                  `SupertexDaemonCompiler.snapshot/restore`. M7.5.5
                  end-to-end test gates flipping
                  `SIDECAR_COMPILER=supertex-daemon` to default;
                  M7.4.2 gates checkpoint persistence ever doing
                  anything observable in prod.
      - [~] **M7.5** — Supertex `--daemon DIR` adoption. Upstream mode
            landed (discussion 71); slotted after M7.4 so checkpoint
            serialisation can ride the same channel.
            - [x] M7.5.0 — Bump `vendor/supertex` to `c571420`;
                  `build/supertex` + `build/supertex_daemon`. _(iter 90.)_
            - [x] M7.5.1 — `daemonProtocol.ts`: `parseDaemonLine` for the
                  four stdout line types (`[N.out]`, `[rollback K]`,
                  `[error <reason>]`, `[round-done]`); `DaemonLineBuffer`
                  splits chunks on `\n`, EOF-partial → violation.
                  _(iter 91.)_
            - [x] M7.5.2 — `SupertexDaemonCompiler`
                  (`supertexDaemon.ts`): persistent process per project,
                  lazy spawn on first `compile()`, waits for
                  `supertex: daemon ready` stderr marker, writes
                  `recompile,<N|end>\n`, assembles chunk files into a
                  single PDF segment. `close()` is stdin EOF →
                  `gracefulTimeoutMs` (5s) → SIGTERM → `killTimeoutMs`
                  (2s) → SIGKILL. Concurrent `compile()` calls reject.
                  Gated behind `SIDECAR_COMPILER=supertex-daemon`;
                  production default `supertex` unchanged. _(iter 107.)_
            - [x] M7.5.3 — `[error <reason>]` → `compile-status` with
                  `state: "error", detail: <reason>` (already present in
                  `packages/protocol/src/index.ts:57`); surfaced in
                  `apps/web/src/lib/wsClient.ts:121-126` as `lastError`.
                  Sidecar wire path covered by
                  `serverCompileError.test.mjs` (iter 114); daemon half
                  by `supertexDaemonCompiler.test.mjs` "error+round-done"
                  (iter 113).
            - [x] M7.5.4 — Resolved by deleting `pdfStabilityWatcher.ts`
                  (iter 115). Neither compile path needs filesystem
                  polling: `SupertexOnceCompiler` returns after the
                  child exits with the PDF fully written;
                  `SupertexDaemonCompiler` consumes `[round-done]` as
                  the canonical stability signal. Recoverable from git
                  if a future streaming shape ever needs it.
            - [x] M7.5.5 — Integration tests against the fake daemon
                  (`supertexDaemonCompiler.test.mjs`). Covered: initial
                  compile, targetPage clamp, persistent process across
                  rounds, error+round-done, protocol violation, round
                  timeout, close idempotent, concurrent reject, spawn
                  ENOENT, **rollback truncates assembled segment**,
                  **error→ok recovery on same process** _(iter 113)_.
                  Iter 121 fixed a 0/1-indexing mismatch:
                  `SupertexDaemonCompiler.assembleSegment` (and the
                  fake daemon) used 0-indexed chunks, but the upstream
                  protocol (discussion 71) and real binary emit
                  `[1.out]`/`1.out` … `[N.out]`/`N.out`. After the fix
                  a manual `SupertexDaemonCompiler` smoke against
                  `vendor/supertex/build/supertex --daemon` produces a
                  121 KB `%PDF` segment from a 3-page fixture,
                  deterministic across runs.
                  Iter 122 added the standing real-ELF gold test:
                  `tests_gold/lib/test/supertexDaemonReal.test.mjs`
                  + `tests_gold/cases/test_supertex_daemon_real.py`
                  drive `vendor/supertex/build/supertex --daemon`
                  against a 2-page `.tex` fixture, assert a `%PDF`
                  segment > 1 KB, and exercise the persistent
                  process across two compile rounds. Self-skips if
                  the binary or system `lualatex` are absent
                  (printed `SKIP`, exit 0) so a fresh checkout
                  without the submodule built still passes. With
                  this in place, flipping `SIDECAR_COMPILER=
                  supertex-daemon` to the production default is no
                  longer gated on M7.5.5 — only on the sidecar
                  image actually building both binaries.

- [~] **M8 — Acceptance pass + Playwright (pulled forward).**
      - [x] M8.pw.0 — Playwright skeleton. _(iter 78.)_
            `tests_gold/setup_playwright.sh` (DrvFs-aware install to
            `~/.cache/tex-center-pw/`), `playwright.config.ts` with
            `local`/`live` projects, Python wrapper gates `live` on
            `TEXCENTER_LIVE_TESTS=1`.
      - [x] M8.pw.1 — Session-cookie injection + authed surface.
            _(iter 79, 82–86.)_ `mintSession` helper; `flyProxy.ts`
            spawns `flyctl proxy`; `authedPage` fixture; `local` uses
            PGlite-over-TCP (`maxConnections: 16` workaround).
            Playwright `globalSetup` boots PGlite + dev server.
      - [x] M8.pw.2 — Deploy-iteration verification.
            `verifyLive.spec.ts` encodes the five `VERIFY.md` probes;
            WS probes use Node's `https.request`. Canonical:
            `TEXCENTER_LIVE_TESTS=1 bash tests_gold/run_tests.sh`.
            _(iter 98.)_
      - [ ] **M8.acceptance** — Walk the seven `GOAL.md` acceptance
            criteria end-to-end on prod, fix gaps. Real OAuth
            consent-screen driving stays out of scope (HTTP-handshake
            check + cookie-injection authed tests cover the same
            surface).

## Priority block (iter 131, discussion-revised)

Two production-down OAuth-callback bugs in 24h (iter 129 `jose`
module-not-found, iter 131 user-upsert email-unique collision)
exposed that the current verification surface — `verifyLive.spec.ts`
+ cookie-injected authed probes — leaves the full callback path
untested. discussion/131 promotes the following over the open M7.x
work; do **not** start M7.4.2, M7.2, or refactor/plan-review iters
until this block lands. One slice per iteration.

- [x] **M8.smoke.0** — `scripts/smoke-runtime-image.sh` +
      `smoke` job in `.github/workflows/deploy.yml` (deploy now
      `needs: smoke`). Script builds `apps/web/Dockerfile`, runs
      with placeholder `SESSION_SIGNING_KEY` + `GOOGLE_OAUTH_*` env,
      `DATABASE_URL` unset (the M8.smoke.0 open question resolved
      by omitting the URL — `runBootMigrations` short-circuits on
      no URL, and no probed GET touches the DB without an auth'd
      session). Probes all eight endpoints from PLAN; flags any
      `ERR_MODULE_NOT_FOUND` / `Cannot find package` / unexpected
      5xx. Structural invariants pinned by
      `tests_normal/cases/test_deploy_workflow.py`
      (`test_smoke_job_gates_deploy`,
      `test_smoke_script_probes_all_endpoints`). _(iter 132.)_
- [ ] **M8.pw.3** — Real OAuth round-trip via a dedicated Google
      Cloud service account with the OAuth client pre-consented.
      Test obtains an ID token (refresh-token or JWT exchange),
      constructs a synthetic `code` mirroring the real callback
      payload, presents it to `/auth/google/callback` with a
      matching `state` cookie, asserts 302 → `/projects` and the
      `tc_session` passes the session hook. Wired into
      `verifyLive.spec.ts` as a deploy gate. This is the test that
      would have caught both production-down bugs.
- [ ] **M8.pw.4** — Full product-loop Playwright spec. With
      pw.3's service-account auth: sign in, create project, type a
      minimal LaTeX source, wait for a `pdf-segment` WS frame,
      assert PDF.js rendered a non-blank canvas. Gated by
      `TEXCENTER_FULL_PIPELINE=1` so it doesn't beat on prod every
      iter, but mandatory on any deploy-touching iter. Subsumes
      M8.acceptance.

## Current focus

**Iter 131 (discussion mode).** Second production-down OAuth-
callback bug in 24h. Real PG error (uncovered by reading the live
`users` table directly, not by `flyctl logs` — its 100-line buffer
had rolled past): `UNIQUE (email)` collision between the iter-109
seed row (`google_sub = 'probe-jamievicary-livefix'`,
`email = 'jamievicary@gmail.com'`) and the real OAuth callback
(same email, real google_sub). `ON CONFLICT (google_sub)` couldn't
fire — the new sub didn't match — so the `unique_email_key`
constraint raised before the conflict branch. Two fixes landed:

1. One-shot UPDATE on live DB aligned the seed row's `google_sub`
   to the real value; next OAuth attempt hits the conflict-DO-
   UPDATE branch.
2. `0002_drop_users_email_unique.sql` removes the redundant
   constraint; `drizzle.ts:24` dropped `.unique()`. PGlite test
   pins the regression (same email + different google_sub →
   succeeds). Applies to live on next deploy via the existing
   `RUN_MIGRATIONS_ON_BOOT=1` path.

See `.autodev/discussion/131_{question,answer}.md` for full
diagnosis. The deeper issue (verification surface gap) is
addressed by the priority block above — see "Priority block
(iter 131, discussion-revised)".

**Next ordinary iteration:** M8.pw.3 (real OAuth round-trip via a
dedicated Google Cloud service account). M8.smoke.0 landed iter
132; M7.4.2 and M7.2 still parked until the rest of the priority
block lands.

**Prior callback fix (iter 129) — VERIFIED LIVE iter 130.**
Production-down: `/auth/google/callback` returned 500 because
`apps/web/Dockerfile`'s runtime stage shipped no `node_modules`,
and adapter-node leaves `jose` (Google ID-token JWKS verify) as
an external bare specifier. Latent since the first deploy with
auth: every other live probe avoids `jose`'s import graph. Fix:
`pnpm deploy --prod` in the builder, `COPY` the resulting
`node_modules` into the runtime stage; regression-pinned by
`test_web_dockerfile.test_runtime_carries_prod_node_modules`; new
`/auth/google/callback?error=fake → 400` probe added to both
`deploy/VERIFY.md` and `verifyLive.spec.ts`. Iter 130: after CD
of `eed6836` completed, live probe of the callback now returns
400 (was 500); `TEXCENTER_LIVE_TESTS=1 python3 -m unittest
tests_gold.cases.test_playwright.TestPlaywrightLive` passes.
See discussion/129 for full diagnosis.

**Next ordinary iteration:** M7.4.2 — upstream supertex daemon
serialise/restore wire (PLAN "Candidate supertex (upstream)
work" item 2), then real `SupertexDaemonCompiler.snapshot/
restore`. With M7.4.1 landed, the sidecar half is fully wired:
the day a real `snapshot()` returns non-null, persistence is
automatic.

`SIDECAR_COMPILER=supertex-daemon` is now the production default
(iter 123 flipped `apps/sidecar/Dockerfile`); the next sidecar
redeploy moves the live site onto the persistent-daemon path.
Iter 124 added `.github/workflows/deploy-sidecar.yml` — path-gated
on `apps/sidecar/**`, `vendor/supertex`, `vendor/engine/**`, the
shared `packages/*` the sidecar depends on, lockfile, workspace,
and the workflow file itself; plus `workflow_dispatch` for
manual reruns. First push to `main` touching a gated path
deploys automatically. To force the daemon-default cutover
sooner without a code change, `gh workflow run
deploy-sidecar.yml`. Structural invariants pinned by
`tests_normal/cases/test_deploy_sidecar_workflow.py`.

Smaller alternatives if M7.4.2 is blocked on upstream:
- M7.2 `/ws/project/<id>` routing-per-project plumbing.

The `verifyLiveWsUpgrade` spec still needs
`TEXCENTER_LIVE_TESTS=1` + `FLY_API_TOKEN` + `SIDECAR_APP_NAME`
in the env to run against prod — first deploy-touching
iteration that does so will exercise it end-to-end.

## Live caveats

- Production default is `SIDECAR_COMPILER=supertex-daemon` (iter
  123); takes live effect on next sidecar deploy. Until that
  redeploy, the running sidecar image still has the once-compiler
  baked in.
- `app.db` only powers `/healthz` (`SELECT 1`, reports `db: { state }`).
  Same endpoint reports `blobs: { state }` via `BlobStore.health()`;
  future S3 adapter must implement it. `/healthz` is intentionally a
  liveness probe (no backing-service status) — `/readyz` candidate in
  FUTURE_IDEAS.
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

1. ~~`--daemon DIR` mode.~~ **Landed upstream** (discussion 71). Sidecar
   adoption tracked as M7.5. Stdout protocol: four line types —
   `[N.out]`, `[rollback K]`, `[error <reason>]`, `[round-done]`;
   EOF on stdin = clean-shutdown signal. `[error <reason>]` is
   additive vs original sketch → new `compile-status:error` wire
   frame (M7.5.3).
2. **Checkpoint serialise/restore to a single blob.** (M7.4)
