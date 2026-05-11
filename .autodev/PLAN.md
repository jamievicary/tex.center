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
                  Landed iter 73: `tex-center` Fly app created in
                  `fra`, `FLY_API_TOKEN` GH secret set,
                  `flyctl deploy --remote-only` succeeded after
                  fixing an ESM runtime bug (added
                  `{"type":"module"}` stub in `apps/web/Dockerfile`
                  runtime stage — adapter-node emits ESM but the
                  bare `/app/build/` had no sibling package.json).
                  Dedicated IPv4 blocked on trial org (shared v4
                  `66.241.125.118` works for custom apex via SNI);
                  dedicated IPv6 `2a09:8280:1::114:4adc:0` issued.
                  Cloudflare apex A/AAAA reconciled by
                  `scripts/cloudflare-dns.mjs`; Fly cert issued via
                  TLS-ALPN-01 within ~30s (no ACME TXT needed).
                  `https://tex.center/healthz` → 200 JSON,
                  `https://tex.center/` → 200 HTML. State captured
                  in `deploy/README.md`.
                  Eight steps (per discussion 70):
                  1. `FLY_API_TOKEN=$(cat creds/fly.token) flyctl
                     apps create tex-center` (region `fra`).
                  2. `GH_TOKEN=$(cat creds/github.token) gh secret
                     set FLY_API_TOKEN < creds/fly.token` on
                     `github.com/jamievicary/tex.center`.
                  3. First deploy — push a no-op commit to `main`
                     or `flyctl deploy --remote-only` directly.
                  4. `flyctl ips allocate-v4` + `allocate-v6`;
                     capture addresses.
                  5. `flyctl certs create tex.center`; capture
                     ACME DNS-01 challenge name + value.
                  6. Run `scripts/cloudflare-dns.mjs` with the
                     captured IPs and ACME challenge to upsert
                     apex `A`/`AAAA` and `_acme-challenge` TXT.
                     Poll `flyctl certs show tex.center` until
                     `Ready`.
                  7. Probe `https://tex.center/healthz` → 200;
                     probe `https://tex.center/` → white sign-in.
                  8. Commit captured state (IPs, app metadata)
                     into a `deploy/` doc; never commit tokens.

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

- [ ] **M8 — Acceptance pass.** Walk the seven `GOAL.md` acceptance
      criteria end-to-end on prod, fix gaps. Playwright lives here.

## Current focus

**Next ordinary iteration:** M7.0.2 — author
`apps/sidecar/fly.toml` for a `tex-center-sidecar` Fly app in `fra`
(no public IPs, internal port 3001), then `flyctl deploy
--remote-only`. M7.0.1 landed iter 75 (engine ELF vendored at
`vendor/engine/x86_64-linux/lualatex-incremental`, runtime stage
COPYs + wraps + dumps fmt).

Smaller alternatives if M7.0 hits a blocker:
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
- Projects dashboard slice landed iter 68: `/projects/+page.{server.ts,svelte,ts}`
  lists `listProjectsByOwnerId(db, session.user.id)` and a POST
  `?/create` action calls `createProject` then 303s to
  `/editor/<id>`. Editor moved from `/editor/+page.*` to
  `/editor/[projectId]/+page.*`; server load fetches the project
  by id and 404s if missing or not owned by the current user.
  Editor page uses `data.project.id` to build the WS URL
  (`/ws/project/<encodeURIComponent(id)>`); sidecar's path
  parameter is already plumbed end-to-end. `routeRedirect.ts`:
  `PROTECTED_PREFIXES` += `/projects`; `SIGNED_IN_HOME` →
  `/projects`. OAuth callback `SUCCESS_PATH` → `/projects`.
  The sidecar `getProject(projectId)` cache still seeds the
  per-project Y.Doc lazily, so a freshly-created project's
  first WS connect populates the cache; persistence hydrates
  `main.tex` from the (empty) blob set, which is the same path
  the legacy `"default"` literal exercised.
- Sidecar `/ws/project/:projectId` validation tightened iter 69:
  the `?? "default"` fallback is gone; ids must match
  `/^[A-Za-z0-9_-]+$/` (same shape `ProjectWorkspace` already
  enforced) or the WS is closed with code `1008 invalid projectId`
  before `getProject` runs. New `serverProjectIdValidation.test.mjs`
  exercises `bad.id`, `has space`, `trailing!` rejection and the
  positive `good-id_123` open path.
- Project-row storage primitives landed iter 67:
  `packages/db/src/projects.ts` exports `createProject`,
  `getProjectById(db, id)` (null-on-miss), and
  `listProjectsByOwnerId(db, ownerId)` (sorted by `created_at`
  then `id` for deterministic test ordering). Re-exported from
  `packages/db/src/index.ts`. PGlite gold case
  `tests_gold/cases/test_pglite_projects.py` exercises
  insert/fetch round-trip, list-by-owner across two owners with
  empty-list edge case, miss-by-id, and FK enforcement on
  `ownerId`. No web/sidecar wiring yet — every runtime codepath
  still uses the hardcoded literal `"default"` for the project
  id; the dashboard + per-project routing slice lifts that.
- File-tree upload landed iter 66: `upload-file` protocol verb
  carrying `{ name, content }` (UTF-8 text); `ProjectPersistence.
  addFile(name, content?)` extended with an optional content
  param — the PUT carries the encoded bytes and the file's
  `Y.Text` is populated inside a `doc.transact` so observers see
  one coherent update; create-file's empty-blob path is
  unchanged. `WsClient.uploadFile`, `FileTree.svelte` hidden
  file-input + "↑" button (rejects names via the existing local
  validator before sending), editor-page wiring, and a new
  serverUploadFile test (upload → file-list + Y.Text + blob;
  duplicate + invalid rejected with `file-op-error op:
  upload-file`; cold restart preserves content). Binary asset
  uploads remain future work — `Y.Text` is text-only and a
  separate binary-blob channel is the next design step there.
- Wire-level `file-op-error` landed iter 65: protocol variant
  `{ op: create-file|delete-file|rename-file, reason }`; sidecar
  unicasts to the originator on each rejection branch (no
  broadcast — other viewers didn't request the op);
  `WsClientSnapshot.fileOpError` populated on receipt and cleared
  on the next `file-list`; `FileTree.svelte`'s create-form area
  shows the server reason (the local validator still wins when
  the user is mid-typo). Closes the iter-64 "race rejection is
  log-only" gap and gives any future file-tree verb (upload, etc.)
  a ready feedback channel.
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
  engine path today; daemon-mode adoption (M7.5) is unblocked
  upstream but deferred behind M6.3.1 and M7.0.
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
