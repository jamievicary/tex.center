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

Roughly: (A) a vertical slice runnable locally end-to-end, (B)
supertex daemon-isation, (C) Fly deployment + per-project Machine
spawning, (D) auth + production polish.

- [x] **M0 — Repo scaffolding** _(iter 2–3)_ — pnpm workspace
      (`apps/web`, `apps/sidecar`, `packages/protocol`), Node 20
      auto-provisioned into `.tools/`, `vendor/supertex` submodule.
- [x] **M1 — Static frontend shell** _(iter 4)_ — SvelteKit
      (`adapter-static`, runes, no SSR). `/` white sign-in page;
      `/editor` three-panel grid (tree stub / CM6 / PDF.js).
- [x] **M2 — Sidecar service skeleton** _(iter 5–6)_ — Fastify +
      `ws`, in-memory Yjs, "viewing page N" channel, fixture
      compile loop. `packages/protocol` defines wire format
      (Yjs frames, compile-status, pdf-segment). Browser
      `WsClient` + `PdfBuffer`; `y-codemirror.next` binds CM6.
- [~] **M3 — supertex compile path.** Sidecar drives
      `vendor/supertex` per compile request. The persistent /
      streaming variant waits on an upstream `--daemon DIR` mode
      (see "Candidate supertex work" below); until then,
      `SupertexOnceCompiler` is the real path, with a sidecar-side
      PDF-stability debouncer covering the post-engine settle
      window.
      - [x] **M3.0** — Compiler interface + `targetPage` plumbing
            (`apps/sidecar/src/compiler/types.ts`). _(iter 8)_
      - [x] **M3.1** — `ProjectWorkspace`: atomic `writeMain`,
            strict id regex, scratch-dir lifecycle. _(iter 9)_
      - [x] **M3.2** — `SupertexOnceCompiler`: `--once
            --output-directory`, 60s wallclock, ENOENT/non-zero/
            missing-PDF paths. _(iter 12; simplified iter 41 —
            `--live-shipouts` and `--target-page=N` emission
            removed alongside their consumers.)_
      - [~] **M3.6** — `awaitPdfStable` watcher
            (`apps/sidecar/src/pdfStabilityWatcher.ts`) lands iter
            41 with fake-clock tests. Not yet wired into
            `runCompile` — the once-path returns after the engine
            exits, so calling it would only add latency. Wires in
            when a streaming compiler (`--daemon DIR` consumer)
            returns before the PDF settles.

      **Retired (iter 41).** `SupertexWatchCompiler` (M3.3),
      `ShipoutSegmenter` (M3.4), and the `--help` feature detector
      (M3.5) were ripped out: they were built against a two-flag
      upstream contract (`--ready-marker`, `--target-page=N`) that
      has been superseded by the unified `--daemon DIR` ask. Old
      logs 13–15 retain the historical detail.

      Cutover: `SIDECAR_COMPILER` env-var stays for now —
      `fixture` (default for dev/unit) vs `supertex` (production,
      once the deploy image carries the binary).

- [~] **M4 — Persistence.** Postgres (Drizzle) for entities; Tigris
      for blobs (project files, checkpoints, PDF segments).
      - [x] **M4.0** — `packages/db` data model + initial SQL
            migration; spec/SQL drift caught by `schema.test.mjs`.
            _(iter 16)_
      - [x] **M4.1** — Drizzle `pgTable`s matching the migration;
            cross-check test `drizzle.test.mjs`. _(iter 17)_
      - [x] **M4.2.0** — `postgres@^3.4.5` driver + `createDb`/
            `closeDb`; `Migration` loader (sha256 + lex sort);
            `applyMigrations` (idempotent, per-migration
            transaction); CLI `pnpm --filter @tex-center/db
            db:migrate`. _(iter 18)_
      - [x] **M4.2.1** — PGlite-backed migration integration test
            (no docker required). `MigrationsDriver` interface;
            `postgresJsDriver(sql)` for prod. Gold case
            `tests_gold/cases/test_pglite_migrations.py`. _(iter
            23)_
      - [x] **M4.2.2** — Sidecar wires `@tex-center/db`;
            `app.db: DbHandle | null` decorated from
            `DATABASE_URL` (or test injection). _(iter 19)_
      - [~] **M4.3 — Project hydration.**
            - [x] **M4.3.0** — `packages/blobs`: `BlobStore`
                  interface + `LocalFsBlobStore` (atomic write-
                  rename, strict `validateKey`). _(iter 24)_
            - [ ] **M4.3.1** — `S3BlobStore` against AWS SDK
                  behind same interface; gold-test against MinIO
                  once the docker-compose stack lands (see
                  `FUTURE_IDEAS.md`). `health()` should be a
                  `HeadBucket`-class call.
            - [~] **M4.3.2** — Sidecar wiring. **Source-file half
                  done.** `buildServer` accepts `blobStore?` (env
                  selector: `BLOB_STORE=local|s3|none`). On first
                  `getProject(id)`, `main.tex` at
                  `projects/<id>/files/main.tex` hydrates into
                  `Y.Text` before initial state ships. After every
                  `writeMain` (decoupled from compile success per
                  iter 28), the source is `put` if it differs from
                  the last persisted copy, gated by a `canPersist`
                  flag set only on hydration success (iter 29 —
                  prevents clobbering remote with empty Y.Text on
                  hydration outage). Iter 30 extracted
                  `apps/sidecar/src/persistence.ts` to own this
                  policy. **Outstanding:** checkpoint persistence
                  on `Compiler.close()` waits for M3.5/M7 — no
                  checkpoint-blob protocol on the compiler
                  interface yet, and supertex doesn't serialise
                  them either.

- [~] **M5 — Auth.** Google OAuth (Authorization Code), server-side
      sessions, allowlist `jamievicary@gmail.com`. Replaces M1 mock.
      - [x] **M5.0** — `packages/auth`: pure-logic leaf with email
            allowlist (`isAllowedEmail`, case-insensitive, trimmed)
            and HMAC-SHA256-signed session tokens
            (`signSessionToken` / `verifySessionToken`, base64url,
            constant-time compare, caller-supplied `nowSeconds`).
            No I/O, no module state. _(iter 32)_  PKCE primitives
            (`generatePkce` / `computeChallenge` / `isValidVerifier`,
            S256 only, RFC 7636 Appendix B vector covered) added in
            iter 33; shared `b64u.ts` extracted from `session.ts`.
      - [~] **M5.1** — Google OAuth callback wiring (PKCE, JWKS
            verify of the ID token, mint a session row + cookie
            via `packages/auth`).
            - [x] **M5.1.0** — `apps/web` swapped from
                  `@sveltejs/adapter-static` to `adapter-node`
                  (iter 34). Architecture decision: one origin,
                  SvelteKit `+server.ts` routes are the control
                  plane's HTTP surface. The "Fastify" call in
                  GOAL is already satisfied by `apps/sidecar`
                  (the per-project tier); a separate control-
                  plane Fastify app would just duplicate routing
                  + static-asset serving that SvelteKit's Node
                  server already does. Pages keep `prerender =
                  true; ssr = false` so the white sign-in page
                  and editor shell still ship as static
                  artefacts; only `+server.ts` endpoints render
                  dynamically. Build output goes to
                  `apps/web/build/` (already gitignored), run
                  with `node apps/web/build/index.js`.
            - [x] **M5.1.1** — `/auth/google/start` `+server.ts`
                  (iter 35). `packages/auth` factored a generic
                  `signed.ts` (HMAC-SHA256 over opaque
                  payload-strings); `session.ts` rewritten on top,
                  new `state.ts` adds
                  `signStateCookie`/`verifyStateCookie` for
                  `{state, verifier, exp}`. The route reads config
                  via `loadOAuthConfig()` (env +
                  `creds/google-oauth.json`), generates PKCE +
                  random state, calls the pure
                  `buildGoogleAuthorizeRedirect` builder
                  (`apps/web/src/lib/server/oauthStart.ts`), and
                  302-redirects to Google with `Set-Cookie:
                  tc_oauth_state=…; Path=/auth; HttpOnly;
                  SameSite=Lax; Secure (https only); Max-Age=600`.
                  `Cache-Control: no-store`. `secureCookie` keys
                  off `url.protocol === "https:"` so dev over
                  localhost still works.
            - [~] **M5.1.2** — `/auth/google/callback`
                  `+server.ts`.
                  - [x] **M5.1.2a** — OAuth round-trip lands
                        (iter 36). Pure `resolveGoogleCallback`
                        (`apps/web/src/lib/server/oauthCallback.ts`)
                        orchestrates state-cookie verify → state
                        compare → token exchange → JWKS verify →
                        allowlist check → mint signed session
                        cookie. All I/O injected; unit test stubs
                        every branch. Concrete I/O in
                        `googleTokens.ts` (`fetch` for the token
                        endpoint, `jose.createRemoteJWKSet` +
                        `jwtVerify` for the ID token). `jose` added
                        to `apps/web` deps. Route file at
                        `apps/web/src/routes/auth/google/callback/+server.ts`.
                        Cookie names: `tc_oauth_state` cleared on
                        every termination; `tc_session` minted on
                        success (Path=/, HttpOnly, SameSite=Lax,
                        Secure on https, Max-Age=30 days).
                  - [x] **M5.1.2b** — Session-row persistence (iter 37).
                        `packages/db/src/users.ts` adds
                        `findOrCreateUserByGoogleSub` (Drizzle
                        `insert ... onConflictDoUpdate(target:
                        google_sub)` returning the upserted row);
                        `sessions.ts` adds
                        `insertSession({userId, expiresAt})`.
                        Helpers typed against `PostgresJsDatabase
                        <Schema>`; PGlite tests cast through. New
                        gold case `test_pglite_users_sessions.py`
                        applies real migrations to PGlite and
                        exercises upsert-stability, FK rejection,
                        and `updated_at` monotonicity.
                        `apps/web/src/lib/server/db.ts` adds a
                        process-lifetime `getDb()` singleton that
                        lazily reads `DATABASE_URL` and registers a
                        SIGTERM/SIGINT close hook. The route's
                        orchestrator injection point widened from
                        `mintSid: () => string` to
                        `createSession(claims) => Promise<string>`;
                        the route binding upserts the user, inserts
                        the session, and returns the new sid. A new
                        500 branch in `resolveGoogleCallback` surfs
                        DB outages.
            - [x] **M5.1.4** — Editor UI consumption + logout (iter
                  39). `apps/web/src/routes/editor/+page.server.ts`
                  surfaces `{user: {email, displayName}}` from
                  `event.locals.session`. `+page.svelte` adds a
                  topbar with the user's name + a `POST /auth/logout`
                  form. `packages/db/src/sessions.ts` gains
                  `deleteSession(db, sid) → boolean`. Pure
                  orchestrator `apps/web/src/lib/server/logout.ts`
                  (`resolveLogout`) deletes-if-present and always
                  emits clear-cookie + 303 to `/`. Route file at
                  `apps/web/src/routes/auth/logout/+server.ts`;
                  POST-only, CSRF posture = SameSite=Lax + same-
                  origin form. Unit test `logout.test.mjs` + PGlite
                  gold-test extension for `deleteSession` (unknown
                  sid → false, known sid → true + user kept, repeat
                  → false).
            - [x] **M5.1.3** — `hooks.server.ts` (iter 38).
                  `packages/db/src/sessions.ts` adds
                  `getSessionWithUser(db, sid)` (`sessions ⋈
                  users` lookup, `null` on miss). Pure orchestrator
                  `apps/web/src/lib/server/sessionHook.ts`
                  (`resolveSessionHook`): cookie parse → token
                  verify → uuid format check → injected lookup →
                  server-side expiry. Returns
                  `{session, clearCookie, reason}` covering every
                  branch (no-cookie / bad-token / expired-token /
                  bad-sid / no-row / lookup-error / expired-row /
                  ok). DB outage keeps the cookie (transient);
                  every other invalid state clears it.
                  `sessionConfig.ts` adds `loadSessionSigningKey()`
                  (subset of OAuth config, returns `null` when
                  unset). `hooks.server.ts` wires it; protected
                  prefix `/editor` redirects to `/` on no-session.
                  `app.d.ts` declares `App.Locals.session`.
                  `routes/editor/+page.ts` sets `prerender = false;
                  ssr = false` so the hook actually runs. Unit test
                  `apps/web/test/sessionHook.test.mjs` covers every
                  `reason`; PGlite gold test extended for
                  `getSessionWithUser`.
- [~] **M6 — Fly deploy: control plane.** Dockerfile for `apps/web`,
      `fly.toml`, GitHub Actions on push to `main`, custom domain
      `tex.center` via Cloudflare. Scales to zero.
      - [x] **M6.0** — `apps/web/Dockerfile` (multi-stage) +
            `apps/web/.dockerignore` (iter 42). Builder stage
            installs the pnpm workspace from copied manifests
            (`--frozen-lockfile`) and runs `pnpm --filter
            @tex-center/web build`; runtime stage carries only
            `apps/web/build/` (adapter-node bundles all deps),
            `HOST=0.0.0.0`, `PORT=3000`, `CMD ["node",
            "build/index.js"]`. Pinned `PNPM_VERSION` mirrors root
            `packageManager`. Static structural test
            `tests_normal/cases/test_web_dockerfile.py` enforces
            multi-stage + entrypoint + that every workspace
            package has a manifest COPY before the install layer
            (drift would only surface inside Docker otherwise).
            Image not built in CI: no docker in tests_normal, and
            the actual build will run on Fly's builder.
      - [x] **M6.1** — `fly.toml` at repo root (iter 43).
            `app = "tex-center"`, `primary_region = "fra"`,
            `[build] dockerfile = "apps/web/Dockerfile"`,
            `[http_service]` with `internal_port = 3000`,
            `force_https = true`, `auto_stop_machines = "stop"`,
            `auto_start_machines = true`, `min_machines_running =
            0`, single `[[vm]] shared-cpu-1x / 512mb`. No
            `[checks]` block yet — `apps/web` exposes no
            `/healthz`, so adding one would gate deploys on a
            route that always 404s. Structural test
            `tests_normal/cases/test_fly_toml.py` parses the TOML
            and asserts: app name, primary region present,
            dockerfile path, scale-to-zero triple, port matches
            Dockerfile `EXPOSE`/`PORT=3000`, force_https on.
      - [x] **M6.2** — GitHub Actions workflow on push to `main`
            (iter 44). `.github/workflows/deploy.yml`: single
            `deploy` job, `actions/checkout@v4` →
            `superfly/flyctl-actions/setup-flyctl@master` →
            `flyctl deploy --remote-only --config fly.toml
            --dockerfile apps/web/Dockerfile`, with
            `FLY_API_TOKEN` from secrets. `concurrency: fly-deploy
            cancel-in-progress: false` so rapid pushes queue
            rather than abandoning a half-rolled-out Machine.
            20-minute job timeout. Structural test
            `tests_normal/cases/test_deploy_workflow.py` parses
            the YAML and asserts: trigger is `push` on `main`,
            checkout + setup-flyctl steps present, exactly one
            `flyctl deploy` step with `--remote-only` and
            `FLY_API_TOKEN` env, any `--dockerfile` path resolves.
            **One-shot manual steps before first push:** `flyctl
            apps create tex-center`; `gh secret set FLY_API_TOKEN
            < creds/fly.token`.
      - [ ] **M6.3** — Custom domain `tex.center` via Cloudflare
            (`flyctl certs create` + DNS records).
- [ ] **M7 — Per-project Machines.** Control plane spawns/wakes a
      Machine per project; routes WS to it; ~10 min idle auto-stop;
      state persisted to Tigris on stop, rehydrated on start. Image
      carries full TeX Live + supertex. Introduces the checkpoint-
      blob protocol on the compiler interface (closes M4.3.2 tail).
- [ ] **M8 — Acceptance pass.** Walk the seven `GOAL.md` acceptance
      criteria end-to-end on prod, fix gaps. Playwright lives here.

## Current focus

**Next ordinary iteration:** M6.3 — custom domain `tex.center`
via Cloudflare (`flyctl certs create tex.center` + apex A/AAAA
records pointing at the Fly app). M6.0 (Dockerfile) landed iter
42; M6.1 (`fly.toml`) landed iter 43; M6.2 (Actions workflow)
landed iter 44. Smaller alternatives if blocked:
a multi-file-project slice on the sidecar; wiring `awaitPdfStable`
once a streaming compile path exists. M4.3.1 (S3 adapter) still
waits for docker-compose; M4.3.2 checkpoint half waits for the
upstream `--daemon DIR` mode / M7.

M5 tail items deferred to FUTURE_IDEAS: session sweeper for
expired rows, JWKS clock-skew tolerance, GET-via-shim for
logout-from-link.

## Live caveats

- `SIDECAR_COMPILER=supertex` (the once-compiler) is the only
  real engine path today; the streaming variant waits on the
  upstream `--daemon DIR` mode.
- `app.db` only powers `/healthz` today (`SELECT 1`, reports
  `db: { state }`). Same endpoint reports `blobs: { state }` via
  `BlobStore.health()`; the future S3 adapter must implement it.
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
  headlessly without Fly — Docker Compose (see `FUTURE_IDEAS`).

## Candidate supertex (upstream) work

PRs against `github.com/jamievicary/supertex`.

1. **`--daemon DIR` mode.** Single long-running supertex process
   per project: stdin command channel (`recompile,N\n`), chunked
   PDF output (`1.out`, `2.out`, …), stdout control protocol
   (`[N.out]` / `[rollback K]` / `[round-done]`). Replaces the
   per-edit spawn cost of the current once-path and removes the
   need for any in-sidecar PDF-stability heuristic. Once landed,
   a new streaming compiler in `apps/sidecar/src/compiler/`
   consumes it; `awaitPdfStable` either retires or moves to a
   pre-`[round-done]` settle inside that compiler.
2. **Checkpoint serialise/restore to a single blob.** (M7)

(History: the previous two-flag plan — `--ready-marker` and
`--target-page=N` — was superseded by (1); the sidecar code
built against it (`SupertexWatchCompiler`, `ShipoutSegmenter`,
`featureDetect`) was removed in iter 41.)
