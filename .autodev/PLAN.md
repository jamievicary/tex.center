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
      --once --output-directory`. The streaming variant waits on
      the upstream `--daemon DIR` mode (see "Candidate supertex
      work" below).
      - [x] **M3.0** — Compiler interface + `targetPage` plumbing.
            _(iter 8)_
      - [x] **M3.1** — `ProjectWorkspace`: atomic `writeMain`,
            strict id regex, scratch-dir lifecycle. _(iter 9)_
      - [x] **M3.2** — `SupertexOnceCompiler`. _(iter 12;
            simplified iter 41.)_
      - [~] **M3.6** — `awaitPdfStable` watcher exists (iter 41)
            but is **not yet wired into `runCompile`** — the
            once-path returns after the engine exits, so calling
            it would only add latency. Wires in when a streaming
            compiler (`--daemon DIR` consumer) returns before the
            PDF settles.

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
            - [ ] **M6.3.1** — Out-of-tree one-shot: `flyctl apps
                  create tex-center`; first deploy via workflow;
                  `flyctl certs create tex.center`; capture
                  anycast IPs (`flyctl ips list -a tex-center
                  --json`) and ACME challenge; run the iter-46
                  script with them. M8 verifies end-to-end.
                  **One-shot manual steps before first push:**
                  `flyctl apps create tex-center`; `gh secret set
                  FLY_API_TOKEN < creds/fly.token`.

- [ ] **M7 — Per-project Machines.** Control plane spawns/wakes a
      Machine per project; routes WS to it; ~10 min idle auto-stop;
      state persisted to Tigris on stop, rehydrated on start. Image
      carries full TeX Live + supertex. Introduces the checkpoint-
      blob protocol on the compiler interface (closes M4.3.2 tail).

- [ ] **M8 — Acceptance pass.** Walk the seven `GOAL.md` acceptance
      criteria end-to-end on prod, fix gaps. Playwright lives here.

## Current focus

**Next ordinary iteration:** M6.3.1 — out-of-tree one-shot
(requires live Fly + Cloudflare tokens, runs outside autodev).

Smaller in-tree alternatives if blocked:
- Multi-file-project slice on the sidecar. Listing primitive
  `listProjectFiles` landed iter 55; protocol `file-list` control +
  FileTree wiring landed iter 56; per-file `Y.Text` hydration
  landed iter 58; multi-file persistence landed iter 59
  (`maybePersist` walks `knownFiles` and PUTs each changed file;
  `editor/+page.svelte` dropped the readOnly guard; compile
  schedule moved off `text.observe` to `doc.on("update")` so edits
  to any file fire compile-and-persist). Remaining file-tree
  affordances (create / rename / delete) need new protocol verbs
  and are deferred to FUTURE_IDEAS.
- Wiring `awaitPdfStable` once a streaming compile path exists.
- Anything that doesn't require docker (S3 adapter M4.3.1 still
  blocked on docker-compose; checkpoint persistence on M7).
- Refactor iter 60: `ProjectPersistence.files()` now exposes the
  sorted known-file set, so the WS handler no longer calls
  `listProjectFiles` independently — one round-trip removed per
  connection and the file-list emitted to the client now equals
  the set persistence operates on.
- File-tree create landed iter 61: `create-file` protocol verb,
  `ProjectPersistence.addFile(name)` (PUTs an empty blob when
  `canPersist`), `WsClient.createFile`, FileTree new-file input.
- File-tree delete landed iter 62: `delete-file` protocol verb,
  `ProjectPersistence.deleteFile(name)` (rejects `main.tex` and
  unknown names; clears the file's `Y.Text`, removes from
  `knownFiles`/`persistedByName`, deletes the blob when
  `canPersist`), `WsClient.deleteFile`, per-row FileTree "×"
  button.
- Client-side file-name validation landed iter 64:
  `validateProjectFileName` lifted into `@tex-center/protocol` so
  the web client mirrors the sidecar's name-rejection rules.
  `FileTree.svelte` shows an inline error on the create input
  (invalid characters, reserved `main.tex`, duplicate) and
  `alert(reason)` on the rename prompt — the server is still
  authoritative, but the user no longer sees silent swallowing.
  Sidecar `persistence.ts` re-exports `validateProjectFileName`
  from protocol so existing imports continue to work.
- File-tree rename landed iter 63: `rename-file` protocol verb,
  `ProjectPersistence.renameFile(old, new)` (rejects `main.tex` on
  either side, unknown source, duplicate target, invalid name; on
  accept, blob-store path PUTs new key then DELETEs old — DELETE
  failure orphans the old blob rather than rolling back; in-memory
  contents copied via a single `doc.transact`),
  `WsClient.renameFile`, FileTree per-row "✎" button using
  `window.prompt` for the new name. Editor page swaps `selected`
  to the new name when the renamed file was active.

## Live caveats

- `SIDECAR_COMPILER=supertex` (the once-compiler) is the only real
  engine path today; streaming waits on upstream `--daemon DIR`.
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

(History: a previous two-flag plan — `--ready-marker` and
`--target-page=N` — was superseded by (1); the sidecar code built
against it was removed in iter 41.)
