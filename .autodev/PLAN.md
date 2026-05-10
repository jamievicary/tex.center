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
- [~] **M3 — supertex daemon mode.** Sidecar drives `vendor/supertex`
      in watch mode (no new IPC needed — supertex's inotify watcher
      catches workspace writes). Two upstream PRs still
      outstanding; see M3.5.
      - [x] **M3.0** — Compiler interface + `targetPage` plumbing
            (`apps/sidecar/src/compiler/types.ts`). _(iter 8)_
      - [x] **M3.1** — `ProjectWorkspace`: atomic `writeMain`,
            strict id regex, scratch-dir lifecycle. _(iter 9)_
      - [x] **M3.2** — `SupertexOnceCompiler`: `--once
            --output-directory --live-shipouts`, 60s wallclock,
            ENOENT/non-zero/missing-PDF paths. _(iter 12)_
      - [x] **M3.3** — `SupertexWatchCompiler`: persistent process,
            `SUPERTEX_READY` marker sync, lazy spawn, SIGTERM/grace/
            SIGKILL on close. _(iter 13)_
      - [x] **M3.4** — `ShipoutSegmenter`: per-shipout PDF byte-
            range deltas from `--live-shipouts`; falls back to one
            whole-PDF segment. _(iter 14)_
      - [~] **M3.5** — Upstream supertex flags. Sidecar half done
            (iter 15): `<bin> --help` startup detector gates
            emission. Outstanding: PRs against
            `github.com/jamievicary/supertex` adding
            (a) `--ready-marker <STRING>` end-of-round stdout
            signal, (b) `--target-page=N` stop-after-page (CLI
            declares it but errors at runtime). On boot after both
            land, no sidecar changes needed.

      Cutover: `SIDECAR_COMPILER` env-var deleted once
      `supertex-watch` becomes default (post-M3.5).

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
- [ ] **M6 — Fly deploy: control plane.** Dockerfile for `apps/web`,
      `fly.toml`, GitHub Actions on push to `main`, custom domain
      `tex.center` via Cloudflare. Scales to zero.
- [ ] **M7 — Per-project Machines.** Control plane spawns/wakes a
      Machine per project; routes WS to it; ~10 min idle auto-stop;
      state persisted to Tigris on stop, rehydrated on start. Image
      carries full TeX Live + supertex. Introduces the checkpoint-
      blob protocol on the compiler interface (closes M4.3.2 tail).
- [ ] **M8 — Acceptance pass.** Walk the seven `GOAL.md` acceptance
      criteria end-to-end on prod, fix gaps. Playwright lives here.

## Current focus

**Next ordinary iteration:** M5 is functionally complete — auth
loop closes, `/editor` is gated. Two natural next steps:
(a) M6 Dockerfile + `fly.toml` for `apps/web` + GitHub Actions
deploy, or (b) consume `event.locals.session` in the editor UI
(server-side load passing user `displayName`/`email` to the
client, sign-out button posting to a new `/auth/logout`). (b) is
cheaper and unblocks visible smoke-testing; (a) is the
remaining structural milestone before acceptance. Default to
(b) first if no infra ask comes in. Smaller alternatives if
blocked: M3.5 PRs (out of repo), a multi-file-project slice on
the sidecar. M4.3.1 (S3 adapter) still waits for docker-compose;
M4.3.2 checkpoint half waits for M3.5/M7.

## Live caveats

- Real `vendor/supertex` does not yet emit `SUPERTEX_READY`, so
  `SIDECAR_COMPILER=supertex-watch` is fake-only until the
  `--ready-marker` PR lands.
- `--target-page=N` is in upstream CLI but errors at runtime; the
  sidecar gates emission on `<bin> --help` advertising it.
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

PRs against `github.com/jamievicary/supertex`. Tracked in M3.5
unless noted.

1. `--ready-marker <STRING>` — end-of-compile-round stdout
   signal. Required for `SupertexWatchCompiler` against real
   supertex. (M3.5)
2. `--target-page=N` — stop-after-page; flag declared, errors
   today. (M3.5)
3. **Checkpoint serialise/restore to a single blob.** (M7)

(The original "long-running daemon mode" item was superseded by
the iter-8 survey: watch mode + inotify already covers it. The
iter-14 `ShipoutSegmenter` approximates per-shipout deltas
without upstream changes; richer delta protocol can come later
if the approximation proves lossy.)
