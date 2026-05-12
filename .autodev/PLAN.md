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
- [~] **M3 — supertex compile path.** Real engine path today is
      `SupertexOnceCompiler` (per-edit spawn of `supertex --once
      --output-directory`). Streaming variant unblocked upstream
      (discussion 71); sidecar adoption tracked as M7.5.
      - [x] M3.0–M3.2 — Compiler interface, `ProjectWorkspace`,
            `SupertexOnceCompiler`. _(iter 8–12, 41.)_
      - [~] **M3.6** — `awaitPdfStable` watcher exists (iter 41)
            but unwired; subsumed by M7.5 (`[round-done]` *is* the
            stability signal). Watcher stays gated on compiler kind;
            wiring happens inside M7.5.4.

      Retired iter 41: `SupertexWatchCompiler`, `ShipoutSegmenter`,
      `--help` feature detector (superseded two-flag contract).
      `SIDECAR_COMPILER` env-var: `fixture` (dev/unit) vs `supertex`
      (production).

- [~] **M4 — Persistence.** Postgres (Drizzle) for entities;
      Tigris (S3) for blobs.
      - [x] M4.0–M4.2.2 — Schema, tables, migration loader, PGlite
            gold test, `app.db` wiring. _(iter 16–19, 23.)_
      - [~] **M4.3 — Project hydration.**
            - [x] M4.3.0 — `packages/blobs`: `BlobStore` interface
                  + `LocalFsBlobStore`. _(iter 24)_
            - [ ] M4.3.1 — `S3BlobStore` against AWS SDK; gold-test
                  against MinIO once docker-compose lands
                  (`FUTURE_IDEAS.md`). `health()` = HeadBucket.
            - [~] M4.3.2 — Sidecar wiring. **Source-file half done**
                  (iter 28–30): `buildServer` accepts `blobStore?`;
                  hydration into `Y.Text`; `writeMain` persists via
                  `persistence.ts` gated by `canPersist` (set on
                  hydration success). **Checkpoint persistence
                  waits for M7.4** (no checkpoint-blob protocol
                  yet).

- [x] **M5 — Auth.** Google OAuth (Auth Code + PKCE), JWKS verify,
      server-side sessions, allowlist `jamievicary@gmail.com`.
      _(iter 32–39, 47–49.)_ Pure `packages/auth` (HMAC tokens,
      PKCE); `apps/web` start/callback/logout routes; `hooks.
      server.ts` injects `event.locals.session`; `/editor`
      redirects unauth to `/`. JWKS 60s `clockTolerance`. OAuth
      `access_denied` → `/`. Session sweeper storage primitive
      `deleteExpiredSessions` landed iter 54; scheduling deferred
      to FUTURE_IDEAS.

- [~] **M6 — Fly deploy: control plane.**
      - [x] M6.0–M6.2.1 — `apps/web/Dockerfile`, `fly.toml`,
            GitHub Actions deploy, `/healthz`. _(iter 42–45.)_
      - [~] **M6.3** — Custom domain `tex.center` via Cloudflare.
            - [x] M6.3.0 — `scripts/cloudflare-dns.mjs` reconciler.
                  _(iter 46.)_
            - [x] M6.3.1 — Live control-plane deploy. _(iter 73,
                  76.)_ `tex-center` in `fra`, shared IPv4 +
                  dedicated IPv6, Cloudflare apex reconciled, Fly
                  cert via TLS-ALPN-01, OAuth secrets via
                  env-first `oauthConfig.ts`. Procedure in
                  `deploy/README.md`; probes in `deploy/VERIFY.md`.

- [~] **M7 — Sidecar + per-project Machines.**
      - [~] **M7.0** — Single shared sidecar Machine (deployable
            cut so the live site compiles LaTeX).
            - [x] M7.0.0 — `apps/sidecar/Dockerfile` multi-stage
                  + structural test. Engine path `/opt/engine/bin`
                  pre-baked on `$PATH`. _(iter 74)_
            - [x] M7.0.1 — Provision patched lualatex engine.
                  Route (b): prebuilt stripped ELF vendored at
                  `vendor/engine/x86_64-linux/lualatex-incremental`
                  (7.3 MB, glibc ≤ 2.34, runs on bookworm). Runtime
                  copies to `/opt/engine/binary`, installs wrapper
                  `/opt/engine/bin/lualatex-incremental` (sets
                  `TEXFORMATS`, execs `binary --fmt=lualatex`),
                  dumps `lualatex.fmt` in cacheable layer.
                  `TEXMFCNF=/etc/texmf/web2c:/usr/share/texlive/
                  texmf-dist/web2c` set after the apt-install RUN
                  so kpathsea finds `lualatex.ini` on the patched
                  binary. Provenance: `jamievicary/luatex-
                  incremental@aa053dd-dirty`; see
                  `vendor/engine/README.md`. _(iter 75, 87–88.)_
            - [x] M7.0.2 — `apps/sidecar/fly.toml` + Fly app
                  `tex-center-sidecar` in `fra` (6PN-only, no
                  public IPs, port 3001). First deploy _(iter
                  87, 93)_; image runs, ssh-probe compiles
                  `\documentclass{article}…` to valid PDF; primary
                  + standby machines in `fra`. Canonical deploy
                  command in `deploy/README.md`:
                  `flyctl deploy --remote-only --no-public-ips
                  -a tex-center-sidecar --config
                  apps/sidecar/fly.toml .` (always pass **both**
                  `-a` and `--config`).
            - [x] M7.0.3 — Control-plane WS proxy.
                  - [x] M7.0.3.0 — Pure proxy module
                        `apps/web/src/lib/server/wsProxy.ts`. Byte-
                        level forwarder, hooks `http.Server`
                        'upgrade', validates pathname
                        `/^[A-Za-z0-9_-]+$/`, no `ws` dep. _(iter 94.)_
                  - [x] M7.0.3.1 — Custom Node entry `server.ts`
                        + `boot.ts`; built via
                        `scripts/build-server-entry.mjs` (esbuild),
                        `./handler.js` external; SIGTERM/SIGINT
                        10s hard-stop. _(iter 95.)_
                  - [x] M7.0.3.2 — Auth gating: optional
                        `authoriseUpgrade(req)` hook on
                        `wsProxy.ts`; rejects write 401 and destroy
                        without dialling upstream. `wsAuth.ts`
                        adapts `resolveSessionHook`. _(iter 96.)_
                        Bundle gained `@tex-center/db` + drizzle
                        (~300 KB); acceptable for MVP.
                  - [x] M7.0.3.3 — Deploy + verify. _(iter 97.)_
                        Live probes: `/healthz` 200; upgrade
                        `/ws/project/smoke` (no cookie) → 401;
                        upgrade `/ws/nope` → 404. **Happy-path
                        (valid cookie → sidecar wake) not yet
                        verified**: `DATABASE_URL` not set on
                        control plane, so signed cookies still 401
                        (`getDb()` throws, fail-closed). Wiring +
                        live-session probe folded into M7.1.3.

      - [~] **M7.1** — Machines API client in the control plane:
            spawn, wake, idle-stop, destroy. Replace the shared
            sidecar with on-demand per-project Machines.
            - [x] M7.1.0 — Pure-logic Fly Machines API client at
                  `apps/web/src/lib/server/flyMachines.ts`:
                  `MachinesClient` with `createMachine`,
                  `getMachine`, `start/stop/destroyMachine`,
                  `waitForState`; typed `MachineState`,
                  `FlyApiError`; pure helpers
                  `buildMachinesUrl`/`buildAuthHeaders`/
                  `internalAddress`/`parseMachineState`. Default
                  base `https://api.machines.dev/v1`; injectable
                  `fetch`. Internal 6PN form
                  `<id>.vm.<app>.internal`. _(iter 99.)_
            - [x] **M7.1.1 — DB schema for project↔machine
                  mapping.** _(iter 102.)_ Sibling table
                  `machine_assignments` (`project_id` PK,
                  `machine_id`, `region`, `state`, `last_seen_at`,
                  `created_at`) was already declared in
                  `schema.ts` + migration `0001_initial.sql`;
                  iter 102 added the storage primitives
                  (`upsertMachineAssignment`,
                  `getMachineAssignmentByProjectId`,
                  `updateMachineAssignmentState`,
                  `deleteMachineAssignment`) in
                  `packages/db/src/machineAssignments.ts` plus a
                  PGlite integration test. `app_name` left
                  ambient (env-driven on the control plane) since
                  the MVP runs a single sidecar app
                  (`tex-center-sidecar`); promote to a column if
                  multi-app routing lands.
            - [~] **M7.1.2** — Per-project upstream resolver.
                  - [x] M7.1.2.0 — `upstreamResolver.ts`:
                        `createUpstreamResolver({machines, store,
                        sidecarPort, sidecarRegion, machineConfig})`
                        returns
                        `(projectId)→Promise<SidecarUpstream>`.
                        State machine handles started / starting /
                        stopped / suspended / created /
                        stopping/suspending / terminal-recreate. In-
                        process per-projectId promise dedup. Store
                        adapter `dbMachineAssignmentStore(db)` wraps
                        the iter-102 storage primitives.
                        `WsProxyOptions.upstream` widened to
                        `SidecarUpstream | (projectId)=>Promise<…>`;
                        resolution runs *after* the auth gate.
                        Resolver throw → 502 (new
                        `resolve-error` event), upstream never
                        dialled. `BootOptions.resolveUpstream`
                        forwards to the proxy; fallback path is
                        unchanged static envvar. _(iter 103.)_
                  - [ ] M7.1.2.1 — Wire `createUpstreamResolver` in
                        `server.ts` gated on `FLY_API_TOKEN` +
                        `SIDECAR_APP_NAME` + `SIDECAR_IMAGE`; falls
                        back to static envvar if absent. Cover via
                        a small integration test booting `boot()`
                        with a stub `MachinesClient`.
            - [ ] M7.1.3 — `DATABASE_URL` + `FLY_API_TOKEN` secrets
                  on the control plane; deploy; extend
                  `verifyLive.spec.ts` with a happy-path
                  authed-upgrade probe (closes the M7.0.3.3 tail).
            - [ ] M7.1.4 — Idle-stop wiring on per-project Machine
                  side; closes M7.3.
      - [ ] **M7.2** — `/ws/project/<id>` routing per project.
      - [ ] **M7.3** — ~10-min idle auto-stop.
      - [ ] **M7.4** — Checkpoint blob protocol on the compiler
            interface; persist on idle-stop, rehydrate on wake.
            Closes M4.3.2 tail.
      - [~] **M7.5** — Supertex `--daemon DIR` adoption. Upstream
            mode landed (discussion 71); slotted after M7.4 so
            checkpoint serialisation can ride the same channel.
            - [x] M7.5.0 — Bump `vendor/supertex` submodule
                  `69317e8 → c571420`; `make -C vendor/supertex
                  all` builds `build/supertex` + `build/supertex_
                  daemon`. _(iter 90.)_ **Carry-over for M7.5.2**:
                  the sidecar Dockerfile's `RUN make -C
                  vendor/supertex -j` (no target) only builds
                  `build/baseline_snapshot` — implicit first goal
                  hits a prerequisite-only rule. Fix in M7.5.2:
                  switch to `make -C vendor/supertex all` and
                  update `SUPERTEX_BIN` (which currently points at
                  a removed Python entry).
            - [x] M7.5.1 — `apps/sidecar/src/compiler/daemonProtocol.ts`:
                  `parseDaemonLine` for the four stdout line types
                  (`[N.out]`, `[rollback K]`, `[error <reason>]`,
                  `[round-done]`); `DaemonLineBuffer` splits chunks
                  on `\n`, EOF-partial → violation. _(iter 91.)_
            - [ ] M7.5.2 — `SupertexDaemonCompiler` next to
                  `SupertexOnceCompiler`: one persistent process
                  per project, lazy spawn, lifecycle via
                  `Compiler.close()` (stdin EOF → wait → SIGTERM
                  → SIGKILL). Fix M7.5.0 Dockerfile carry-over here.
            - [ ] M7.5.3 — `[error <reason>]` → new
                  `compile-status:error` wire frame in
                  `packages/protocol`; surface in editor UI.
            - [ ] M7.5.4 — Gate `PdfStabilityWatcher` on compiler
                  kind (once-path keeps it; daemon uses
                  `[round-done]`).
            - [ ] M7.5.5 — Integration tests (initial compile,
                  recompile, rollback, error-recovery, clean
                  shutdown); flip `SIDECAR_COMPILER` default to
                  `supertex-daemon` only after this suite is green.

- [~] **M8 — Acceptance pass + Playwright (pulled forward).**
      - [x] M8.pw.0 — Playwright skeleton. _(iter 78.)_
            `tests_gold/setup_playwright.sh` (DrvFs-aware install
            to `~/.cache/tex-center-pw/`), `playwright.config.ts`
            with `local`/`live` projects, `landing.spec.ts`,
            Python wrapper `test_playwright.py` that gates `live`
            on `TEXCENTER_LIVE_TESTS=1`.
      - [x] M8.pw.1 — Session-cookie injection + authed surface.
            _(iter 79, 82–86.)_ `mintSession` helper inserts row +
            signs `tc_session` cookie (default TTL 300s);
            `flyProxy.ts` spawns `flyctl proxy` with four
            distinct-failure-mode error paths; `authedPage`
            fixture branches on project name; `local` target uses
            PGlite-over-TCP via `@electric-sql/pglite-socket`
            (`maxConnections: 16` workaround — default is 1, not
            100 as JSDoc claims); Playwright `globalSetup` boots
            PGlite *and* spawns dev server itself (top-level
            `webServer` block removed iter 86 — env was being set
            after webServer launch). First wave: `authedHome`,
            `projects`, `editor`, `signout`. Editor 404-for-
            stranger case deferred to pw.2 (`+layout.ts` sets
            `ssr=false`).
      - [x] M8.pw.2 — Deploy-iteration verification. _(iter 98.)_
            `verifyLive.spec.ts` encodes the five `VERIFY.md`
            probes (healthz, `/` HTML, OAuth start 302, WS 401,
            WS 404); self-skips when project ≠ `live`; WS probes
            use Node's `https.request` directly. Canonical:
            `TEXCENTER_LIVE_TESTS=1 bash tests_gold/run_tests.sh`.
      - [ ] **M8.acceptance** — Walk the seven `GOAL.md`
            acceptance criteria end-to-end on prod, fix gaps.
            Real OAuth consent-screen driving stays out of scope
            (HTTP-handshake check + cookie-injection authed tests
            cover the same surface).

## Current focus

**Next ordinary iteration:** M7.1.2.1 — wire the resolver into
`server.ts`. The pure resolver landed in iter 103
(`upstreamResolver.ts`); the production entry still falls back to
the static envvar upstream because the secrets (`FLY_API_TOKEN`,
`SIDECAR_APP_NAME`, `SIDECAR_IMAGE`) aren't set on the control
plane yet. M7.1.2.1 plumbs the construction conditional on env;
M7.1.3 deploys + extends `verifyLive.spec.ts`, M7.1.4 closes
idle-stop.

Smaller alternatives if M7.1 hits a blocker:
- Wiring `awaitPdfStable` once a streaming compile path exists.
- Anything that doesn't require docker (S3 adapter M4.3.1 still
  blocked on docker-compose; checkpoint persistence on M7.4).

Closed in-tree slices (consult `git log` / `.autodev/logs/` for
detail): multi-file project (iter 55–60), file-tree CRUD
(iter 61–66), `file-op-error` protocol (iter 64–65), project-row
storage primitives (iter 67), `/projects` dashboard + per-project
`/editor/[projectId]` routing (iter 68), strict sidecar `projectId`
validation (iter 69).

## Live caveats

- `SIDECAR_COMPILER=supertex` (once-compiler) is the only real
  engine path today; daemon-mode (M7.5) deferred behind M7.0.
- `app.db` only powers `/healthz` (`SELECT 1`, reports
  `db: { state }`). Same endpoint reports `blobs: { state }`
  via `BlobStore.health()`; future S3 adapter must implement it.
- Persistence is one-shot per session: permanent blob outage
  means edits this process are never persisted. Acceptable in
  the per-project Machine model where Machines cycle frequently.
- Control plane `DATABASE_URL` not yet set: authed WS upgrade
  collapses to 401 fail-closed. M7.1.3 fixes.

## Local toolchain

Node 20.18.1 auto-provisioned per-checkout into `.tools/node/`
(gitignored) by `tests_normal/setup_node.sh`. Runner then calls
`pnpm install --frozen-lockfile --prefer-offline` and `pnpm -r
typecheck`. pnpm via corepack at the version pinned in root
`package.json#packageManager`.

**DrvFs (/mnt/c) workaround.** WSL2 mounts of the Windows
filesystem can't host pnpm's atomic-rename install reliably
(Windows file watchers hold transient handles → `EACCES`,
half-extracted `_tmp_*` dirs). `setup_node.sh` detects `/mnt/*`
checkouts, stashes `node_modules/` under
`~/.cache/tex-center-nm/<sha1-of-checkout-path>/node_modules`
(ext4), and symlinks back. `node-linker=hoisted` (in repo
`.npmrc`) keeps the layout flat enough for Node's resolver to
walk the realpath correctly.

## Open questions / risks

- **Checkpoint blob size and Tigris round-trip.** Cold-start
  Machine must restore in seconds for the second-visit UX.
  Measure early in M7.4.
- **Fly Machine cold start vs the 100s-of-ms target.** Latency
  goal applies once warm; cold start needs a UI affordance.
- **Yjs for single-user MVP** is over-engineered, but rewriting
  for collab later is worse. Keeping it.
- **Test strategy.** `tests_normal/` = fast unit + type checks;
  `tests_gold/` = end-to-end (Playwright in M8) and
  real-supertex compile tests. Gold needs a docker-compose
  bring-up for the S3 path (`FUTURE_IDEAS.md`).

## Candidate supertex (upstream) work

PRs against `github.com/jamievicary/supertex`.

1. ~~`--daemon DIR` mode.~~ **Landed upstream** (discussion 71).
   Sidecar adoption tracked as M7.5. Stdout protocol is four line
   types — `[N.out]`, `[rollback K]`, `[error <reason>]`,
   `[round-done]`; EOF on stdin = clean-shutdown signal.
   `[error <reason>]` is additive vs. original sketch → new
   `compile-status:error` wire frame (M7.5.3).
2. **Checkpoint serialise/restore to a single blob.** (M7.4)
