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
      - [ ] **M5.1** — Google OAuth callback wiring (PKCE, JWKS
            verify of the ID token, mint a session row + cookie
            via `packages/auth`). Requires apps/web to gain a
            server tier (move off `adapter-static` for the
            callback route, or split a Fastify control-plane
            app) — pick at the iteration that lands it.
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

**Next ordinary iteration:** M3.5 upstream PRs (not actionable
in-repo); a small multi-file project slice (still single-
`main.tex` everywhere); or M5.1 — wire the now-complete
`packages/auth` (allowlist + signed sessions + PKCE) into a real
OAuth callback (needs an apps/web server tier — pick adapter swap
vs. split Fastify control-plane at that iteration).
M4.3.1 (S3 adapter) waits for the docker-compose stack; M4.3.2
checkpoint half waits for M3.5/M7.

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
