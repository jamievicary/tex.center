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
- [~] **M3 — supertex compile path.** Today's real engine path is
      `SupertexOnceCompiler` (M3.2): per-edit spawn of `supertex
      --once --output-directory`. The streaming variant is now
      unblocked — upstream `--daemon DIR` landed (discussion 71);
      sidecar adoption tracked as M7.5.
      - [x] **M3.0** — Compiler interface + `targetPage` plumbing.
            _(iter 8)_
      - [x] **M3.1** — `ProjectWorkspace`: atomic `writeMain`,
            strict id regex, scratch-dir lifecycle. _(iter 9)_
      - [x] **M3.2** — `SupertexOnceCompiler`. _(iter 12;
            simplified iter 41.)_
      - [~] **M3.6** — `awaitPdfStable` watcher exists (iter 41)
            but is **not yet wired into `runCompile`** — the
            once-path returns after the engine exits, so calling
            it would only add latency. **Subsumed by M7.5**: the
            daemon-mode protocol's `[round-done]` *is* the
            stability signal, so the watcher stays gated on
            compiler kind (only the once-path needs it), and
            wiring work happens inside M7.5 rather than here.

      **Retired (iter 41).** `SupertexWatchCompiler` (old M3.3),
      `ShipoutSegmenter` (M3.4), and the `--help` feature detector
      (M3.5) were ripped out: built against the superseded
      two-flag upstream contract.

      Cutover: `SIDECAR_COMPILER` env-var stays — `fixture`
      (default for dev/unit) vs `supertex` (production).

- [~] **M4 — Persistence.** Postgres (Drizzle) for entities;
      Tigris (S3) for blobs.
      - [x] **M4.0–M4.2.2** — Schema, Drizzle tables, migration
            loader + driver, PGlite-backed gold test, sidecar
            wiring via `app.db`. _(iter 16–19, 23.)_
      - [~] **M4.3 — Project hydration.**
            - [x] **M4.3.0** — `packages/blobs`: `BlobStore`
                  interface + `LocalFsBlobStore` (atomic write-
                  rename, strict `validateKey`). _(iter 24)_
            - [ ] **M4.3.1** — `S3BlobStore` against AWS SDK behind
                  same interface; gold-test against MinIO once
                  docker-compose lands (see `FUTURE_IDEAS.md`).
                  `health()` should be a `HeadBucket`-class call.
            - [~] **M4.3.2** — Sidecar wiring. **Source-file half
                  done** (iter 28–30): `buildServer` accepts
                  `blobStore?`; first `getProject(id)` hydrates
                  `main.tex` into `Y.Text`; `writeMain` persists
                  via `apps/sidecar/src/persistence.ts` gated by
                  `canPersist` (set only on hydration success, to
                  prevent clobbering remote with empty Y.Text on
                  outage). **Outstanding:** checkpoint persistence
                  waits for M7 — no checkpoint-blob protocol on
                  the compiler interface yet, and supertex doesn't
                  serialise them either.

- [x] **M5 — Auth.** Google OAuth (Authorization Code) with PKCE,
      JWKS verify of ID token, server-side sessions, allowlist
      `jamievicary@gmail.com`. _(iter 32–39, 47–49.)_ Pure-logic
      `packages/auth` (HMAC-signed session/state tokens, PKCE
      primitives); `apps/web` server routes for start/callback/
      logout; `hooks.server.ts` injects `event.locals.session`;
      `/editor` redirects unauth to `/`. JWKS has 60s default
      `clockTolerance` (iter 47). OAuth `access_denied` (user
      cancel) redirects to `/` rather than 400 (iter 49).

      M5 tail items deferred to FUTURE_IDEAS: GET-via-shim for
      logout-from-link. (Session sweeper storage primitive
      `deleteExpiredSessions` landed iter 54; scheduling deferred.)

- [~] **M6 — Fly deploy: control plane.**
      - [x] **M6.0** — `apps/web/Dockerfile` multi-stage +
            `.dockerignore`; pnpm workspace install, adapter-node
            runtime; structural test enforces multi-stage shape +
            workspace-manifest COPY ordering. _(iter 42.)_
      - [x] **M6.1** — `fly.toml`: `tex-center` / `fra`,
            scale-to-zero, single shared-cpu-1x/512mb. _(iter 43.)_
      - [x] **M6.2** — `.github/workflows/deploy.yml`: single
            `deploy` job, `flyctl deploy --remote-only`,
            `FLY_API_TOKEN` secret, 20-min timeout,
            `concurrency: fly-deploy cancel-in-progress: false`.
            _(iter 44.)_
      - [x] **M6.2.1** — `/healthz` liveness route (no DB touch,
            so transient Postgres outage doesn't scale to zero) +
            Fly check block in `fly.toml`. _(iter 45.)_
      - [~] **M6.3** — Custom domain `tex.center` via Cloudflare.
            - [x] **M6.3.0** — `scripts/cloudflare-dns.mjs`
                  reconciler (`reconcileRecords` pure core +
                  injectable-`fetch` I/O wrappers; CLI flags
                  `--zone --ipv4 --ipv6 [--acme-name --acme-value]
                  [--dry-run]`). _(iter 46.)_
            - [x] **M6.3.1** — Live deploy of the control plane.
                  _(iter 73, 76.)_ `tex-center` Fly app in `fra`,
                  shared IPv4 + dedicated IPv6, Cloudflare apex
                  reconciled, Fly cert via TLS-ALPN-01, OAuth
                  secrets pushed via env-first `oauthConfig.ts`.
                  State + procedure captured in `deploy/README.md`;
                  post-deploy probes in `deploy/VERIFY.md`.

- [~] **M7 — Sidecar + per-project Machines.** Ordinary in-tree
      milestone (not out-of-tree). Decomposed into sub-milestones;
      M7.0 is the smallest deployable cut that makes the live
      site actually compile LaTeX.
      - [~] **M7.0** — Single shared sidecar Machine. Sliced
            because the original entry bundled four
            independently-deployable steps; the live deploy can't
            land until the engine binary provisioning is solved.
            Decision recorded in discussion 70_answer.
            - [x] **M7.0.0** — `apps/sidecar/Dockerfile` +
                  `.dockerignore` + structural test, mirroring
                  `apps/web/Dockerfile`'s shape. Multi-stage:
                  builder runs `pnpm install --frozen-lockfile`,
                  typechecks the sidecar, and `make -C
                  vendor/supertex`; runtime stage installs
                  `texlive-full` + `python3` on top of the Node
                  base, copies the workspace, and runs the
                  sidecar via `pnpm --filter @tex-center/sidecar
                  start`. Engine-binary path `/opt/engine/bin`
                  pre-baked on `$PATH`; provisioning the binary
                  itself is M7.0.1. _(iter 74)_
            - [x] **M7.0.1** — Provision the patched lualatex
                  engine. Route (b) taken (iter 75): the prebuilt
                  stripped ELF is vendored at
                  `vendor/engine/x86_64-linux/lualatex-incremental`
                  (7.3MB, glibc ≤ 2.34, runs on bookworm).
                  Runtime stage `COPY`s it to `/opt/engine/binary`,
                  installs a tiny `/opt/engine/bin/lualatex-
                  incremental` wrapper (sets `TEXFORMATS`, exec
                  `binary --fmt=lualatex`), symlinks
                  `lualatex-append` to the wrapper, and dumps
                  `lualatex.fmt` against the image's texlive-full
                  in a cacheable layer. Provenance:
                  `jamievicary/luatex-incremental@aa053dd` +
                  uncommitted maintainer working-tree as of
                  2026-05-01 (binary is `aa053dd-dirty`). See
                  `vendor/engine/README.md`. Structural test gains
                  `test_runtime_has_engine_binary` and
                  `test_runtime_dumps_lualatex_fmt`. Follow-up in
                  FUTURE_IDEAS: push the dirty changes upstream
                  and switch to a source-built engine for full
                  reproducibility.
            - [ ] **M7.0.2** — `apps/sidecar/fly.toml` and a
                  second Fly app `tex-center-sidecar` in `fra`.
                  First `flyctl deploy --remote-only` against
                  that app. No public IPs (sidecar is reached
                  over 6PN only); internal port 3001.
            - [ ] **M7.0.3** — Control-plane WS proxy. `apps/web`
                  gains a server route at `/ws/project/[id]` that
                  dials `tex-center-sidecar.internal:3001` over
                  Fly's 6PN and pipes the WebSocket through.
                  `routeRedirect.ts` already lets `/ws/*` past
                  auth; this slice adds the proxy plumbing.
      - [ ] **M7.1** — Machines API client in the control plane:
            spawn, wake, idle-stop, destroy. Replace the shared
            sidecar with on-demand per-project Machines.
      - [ ] **M7.2** — `/ws/project/<id>` routing: control plane
            looks up (or creates) the project's Machine and proxies
            the WS to it.
      - [ ] **M7.3** — ~10-min idle auto-stop on per-project
            Machines.
      - [ ] **M7.4** — Checkpoint blob protocol on the compiler
            interface; persist on idle-stop, rehydrate on wake.
            Closes the M4.3.2 tail.
      - [ ] **M7.5** — Supertex `--daemon DIR` adoption. Upstream
            mode landed (see discussion 71_answer); slotted after
            M7.4 so checkpoint serialisation can ride the same
            persistent channel. Sliced:
            - **M7.5.0** — Bump `vendor/supertex` submodule;
              rebuild binary; verify `SupertexOnceCompiler` tests
              still pass.
            - **M7.5.1** — Pure-logic protocol parser in
              `apps/sidecar/src/compiler/daemonProtocol.ts` for
              the four stdout line types (`[N.out]`,
              `[rollback K]`, `[error <reason>]`, `[round-done]`);
              unknown lines = protocol violation.
            - **M7.5.2** — `SupertexDaemonCompiler` next to
              `SupertexOnceCompiler`: one persistent process per
              project, lazy spawn, lifecycle via `Compiler.close()`
              (close stdin → wait → SIGTERM → SIGKILL).
            - **M7.5.3** — `[error <reason>]` → new
              `compile-status:error` wire frame in
              `packages/protocol`; surface in editor UI.
            - **M7.5.4** — Gate `PdfStabilityWatcher` on compiler
              kind (once-path keeps it; daemon uses `[round-done]`).
            - **M7.5.5** — Integration tests (initial compile,
              recompile, rollback, error-recovery, clean shutdown
              on EOF); flip `SIDECAR_COMPILER` default to
              `supertex-daemon` only after this suite is green.

- [~] **M8 — Acceptance pass + Playwright (pulled forward).**
      Walk the seven `GOAL.md` acceptance criteria end-to-end on
      prod, fix gaps. Playwright infrastructure is pulled forward
      ahead of M7.0.3 so the next control-plane redeploy has a
      browser-level acceptance signal (motivation: iter-73
      `/healthz`+`/` probes missed the OAuth bug iter-76 caught;
      see discussion 77). The full seven-criterion acceptance
      pass remains the M8 endpoint.
      - [x] **M8.pw.0** — Playwright skeleton. _(iter 78.)_
            Workspace devDep `@playwright/test@1.49.1`;
            `tests_gold/setup_playwright.sh` provisions Chromium
            + chromium-headless-shell + ffmpeg under
            `.tools/playwright/` (DrvFs-aware: symlinks to
            `~/.cache/tex-center-pw/<hash>/` on `/mnt/*`,
            idempotent skip-if-installed check on the chrome and
            headless_shell binaries);
            `tests_gold/playwright.config.ts` with `local`
            (webServer: `pnpm --filter @tex-center/web dev --port
            3000`, `reuseExistingServer` when not CI) and `live`
            (`baseURL: https://tex.center`, no webServer — gated
            by `PLAYWRIGHT_SKIP_WEBSERVER=1` from the Python
            wrapper) projects; `tests_gold/playwright/landing.spec.ts`
            asserts `/` returns 200, contains exactly one
            `<a>` with `href=/auth/google/start` and text "Sign in
            with Google", zero `<button>`s, and the trimmed
            body innerText equals the sign-in label;
            `tests_gold/cases/test_playwright.py` runs the
            `local` project unconditionally and the `live`
            project only when `TEXCENTER_LIVE_TESTS=1`
            (otherwise `unittest.SkipTest`). Side-fix in
            `apps/web/vite.config.ts`: extended `server.fs.allow`
            to include `realpathSync(node_modules)` so the
            DrvFs-symlinked-to-ext4 layout no longer trips Vite's
            "outside of serving allow list" guard.
      - [~] **M8.pw.1** — Session-cookie injection + authed
            surface.
            - [x] **M8.pw.1.0** — `tests_gold/lib/src/mintSession.ts`:
                  pure helper that inserts a fresh `sessions` row
                  (`insertSession` from `@tex-center/db`) and signs
                  a matching `tc_session` cookie value
                  (`signSessionToken` from `@tex-center/auth`).
                  Default TTL 300s so abandoned rows self-clean
                  via `deleteExpiredSessions`. PGlite gold case
                  `tests_gold/cases/test_mint_session.py` exercises
                  the round-trip (DB row landed, cookie verifies
                  with the same key, fails with a wrong key,
                  rejects expired-at-`exp`, rejects non-integer
                  / non-positive ttl). Helper deps wired via root
                  `package.json` devDependencies on
                  `@tex-center/auth`/`@tex-center/db`/
                  `@electric-sql/pglite`/`drizzle-orm` (rather
                  than making `tests_gold/lib` its own workspace
                  package — keeps Docker contexts unchanged).
                  _(iter 79.)_
            - [~] **M8.pw.1.1** — Playwright `authedPage` fixture
                  + `tests_gold/lib/src/flyProxy.ts` launching
                  `flyctl proxy 5433:5432 -a tex-center-db` for
                  `live` target with a distinct-failure-mode
                  health check. Local target also needs DB
                  co-location with the dev server (PGlite-server
                  or shared ephemeral Postgres); design + land
                  here.
                  - [x] **M8.pw.1.1.a** — `flyProxy.ts` helper
                        (iter 82): `startFlyProxy({app, localPort,
                        remotePort, command?})` spawns `flyctl
                        proxy LOCAL:REMOTE -a APP`, polls
                        `127.0.0.1:LOCAL` until accepting, and
                        returns a `{localPort, close()}` handle
                        with idempotent SIGTERM→SIGKILL cleanup.
                        Four distinct-failure-mode error paths
                        (happy / child-exited-early / port-never-
                        opens / spawn-ENOENT) each surface a
                        recognisable message including captured
                        stderr. Tested in
                        `tests_gold/lib/test/flyProxy.test.mjs`
                        using a stand-in `flyctl` binary built at
                        test time (no real flyctl needed).
                  - [ ] **M8.pw.1.1.b** — `authedPage` Playwright
                        fixture wiring `mintSession` +
                        `startFlyProxy` for the `live` target.
                  - [ ] **M8.pw.1.1.c** — DB co-location for the
                        `local` target. Design + land
                        PGlite-server-or-equivalent so the dev
                        server and the Playwright test process
                        share a writable Postgres-wire DB.
            - [ ] **M8.pw.1.2** — First wave of tests: `/` →
                  `/projects` redirect when authed, `/editor/<id>`
                  three-panel layout DOM presence, `/projects`
                  lists the user's projects, sign-out clears
                  cookie + lands on white `/`. Tests teardown
                  their inserted rows in `afterAll`.
      - [ ] **M8.pw.2** — Deploy-iteration verification. Extend
            `deploy/VERIFY.md` to require `live`-target Playwright
            pass as the deploy-success signal. `tests_gold` case
            for `live` is gated on `TEXCENTER_LIVE_TESTS=1`
            (passes with a clear "skipped" log when unset so the
            default gold run stays clean). Update deploy-touching
            iteration template so M7.0.3 / future control-plane
            redeploys run the `live` suite at the end.
      - [ ] **M8.acceptance** — Walk the seven `GOAL.md`
            acceptance criteria end-to-end on prod, fix gaps.
            Real OAuth consent-screen driving stays out of scope
            (HTTP-handshake check from `deploy/VERIFY.md` probe 3
            plus cookie-injection-authed editor tests cover the
            same surface a human-driven smoke test would catch).

## Current focus

**Next ordinary iteration:** M8.pw.1.1.b — `authedPage`
Playwright fixture wiring `mintSession` + `startFlyProxy` for
the `live` target. Two primitives now exist
(`tests_gold/lib/src/mintSession.ts` iter 79;
`tests_gold/lib/src/flyProxy.ts` iter 82); next step is the
fixture that boots flyctl proxy, opens a `createDb` against
`postgresql://...@127.0.0.1:5433/...`, mints a session, and
`addCookies` before each test. Local-target DB co-location
(pw.1.1.c) deliberately split off — it's a separate design
decision (PGlite-server vs ephemeral Postgres) and the `live`
target is the higher-value path. Queue: pw.1.1.b → pw.1.1.c →
pw.1.2 → M7.0.2 → pw.2 → M7.0.3.

Smaller alternatives if M7.0 hits a blocker:
- Wiring `awaitPdfStable` once a streaming compile path exists.
- Anything that doesn't require docker (S3 adapter M4.3.1 still
  blocked on docker-compose; checkpoint persistence on M7).

Closed in-tree slices (consult `git log` / `.autodev/logs/` for
detail): multi-file project (iter 55–60), file-tree
create/delete/rename/upload (iter 61–66), `file-op-error`
protocol + client validation (iter 64–65), project-row storage
primitives (iter 67), `/projects` dashboard + per-project
`/editor/[projectId]` routing (iter 68), strict sidecar
`projectId` validation (iter 69).

## Live caveats

- `SIDECAR_COMPILER=supertex` (the once-compiler) is the only real
  engine path today; daemon-mode adoption (M7.5) is unblocked
  upstream but deferred behind M7.0.
- `app.db` only powers `/healthz` (`SELECT 1`, reports `db: { state }`).
  Same endpoint reports `blobs: { state }` via `BlobStore.health()`;
  the future S3 adapter must implement it.
- Persistence is one-shot per session: a permanent blob outage
  means edits this process are never persisted. Acceptable in the
  per-project Machine model where Machines cycle frequently.

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
  Measure early in M7.
- **Fly Machine cold start vs the 100s-of-ms target.** Latency
  goal applies once warm; cold start is a longer event needing a
  UI affordance.
- **Yjs for single-user MVP** is over-engineered, but rewriting
  for collab later is worse. Keeping it.
- **Test strategy.** `tests_normal/` = fast unit + type checks
  per iteration; `tests_gold/` = end-to-end (Playwright in M8)
  and real-supertex compile tests. Gold needs a way to run
  headlessly without Fly — docker-compose (see `FUTURE_IDEAS`).

## Candidate supertex (upstream) work

PRs against `github.com/jamievicary/supertex`.

1. ~~**`--daemon DIR` mode.**~~ **Landed upstream** (see
   discussion 71). Sidecar adoption tracked as M7.5 above. Stdout
   protocol is four line types — `[N.out]`, `[rollback K]`,
   `[error <reason>]`, `[round-done]` — and EOF on stdin is the
   clean-shutdown signal. The `[error <reason>]` line is additive
   vs. the original sketch and needs a new `compile-status:error`
   wire frame (M7.5.3).
2. **Checkpoint serialise/restore to a single blob.** (M7.4)

(History: a previous two-flag plan — `--ready-marker` and
`--target-page=N` — was superseded by (1); the sidecar code built
against it was removed in iter 41.)
