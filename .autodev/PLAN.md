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

The work splits roughly into (A) a vertical slice we can run locally
end-to-end, (B) supertex daemon-isation, (C) Fly deployment +
per-project Machine spawning, (D) auth + production polish.

- [x] **M0 — Repo scaffolding.** _(iter 2–3.)_ pnpm workspace
      (`apps/web`, `apps/sidecar`, `packages/protocol`), TS, Node 20
      auto-provisioned into `.tools/`, `tests_normal/` runs
      structural checks + `pnpm -r typecheck`. `vendor/supertex`
      submodule.
- [x] **M1 — Static frontend shell.** _(iter 4.)_ SvelteKit (Svelte
      5 runes, `adapter-static`, `ssr=false`). `/` = white page +
      "Sign in with Google" mock button. `/editor` = three-panel
      grid (file tree stub / CM6 editor / PDF.js viewer).
- [x] **M2 — Sidecar service skeleton.** _(iter 5–6.)_ Fastify +
      `ws` with in-memory Yjs persistence, "viewing page N" channel,
      stub compile loop returning a fixture PDF. `packages/protocol`
      defines the wire format (Yjs frames, compile-status,
      pdf-segment). Browser `WsClient` decodes binary frames and
      applies segments via `PdfBuffer`; `y-codemirror.next` binds
      CM6 to the shared `Y.Text`. Vite proxies `/ws/*`.
- [ ] **M3 — supertex daemon mode.** Decide whether to add daemon
      mode upstream or wrap with a thin per-project supervisor that
      drives `vendor/supertex` per-edit. Likely upstream PR to
      supertex for: (1) long-running stdin/socket protocol, (2)
      `target_page=N` stop, (3) per-shipout PDF byte-range deltas,
      (4) checkpoint serialise/restore to a single blob. Hook the
      sidecar into it; replace the M2 stub.
- [ ] **M4 — Persistence.** Postgres (Drizzle) for users, sessions,
      projects, file metadata. Tigris for file blobs, checkpoint
      blobs, PDF segments. Local dev brings up both in Docker
      Compose. Project open/close hydrates from Tigris.
- [ ] **M5 — Auth.** Google OAuth (Authorization Code), server-side
      sessions, allowlist `jamievicary@gmail.com`. Replace mock auth
      from M1.
- [ ] **M6 — Fly deploy: control plane.** Dockerfile for `apps/web`,
      `fly.toml`, GitHub Actions on push to `main`, custom domain
      `tex.center` via Cloudflare. Scales to zero.
- [ ] **M7 — Per-project Machines.** Control plane spawns/wakes a
      Machine per project on demand, routes WebSocket to it, idle
      auto-stop after ~10 min, state persisted to Tigris on stop and
      rehydrated on start. Image carries full TeX Live + supertex.
- [ ] **M8 — Acceptance pass.** Walk the seven `GOAL.md` acceptance
      criteria end-to-end on prod, fix gaps.

## Current focus

**M3.2 `SupertexOnceCompiler`** — spawns
`vendor/supertex/bin/supertex paper.tex --once --output-directory
<ws>/out` per compile, reads PDF off disk, returns a single segment.
Selected via `SIDECAR_COMPILER=supertex-once`; default stays
`fixture` until parity is good. Dev loop today: sidecar+web pnpm
dev tasks, Yjs↔CM6 round-trip, sidecar mirrors `main.tex` to scratch
dir per compile and ships fixture PDF.

### Survey of `vendor/supertex` (iter 8)

`supertex` already has a long-running watch mode. The CLI is
`bin/supertex paper.tex`; the daemon (C, `tools/supertex_daemon.c`)
spawns lualatex-incremental under the LD_PRELOAD shim, owns the
watch loop, takes a frozen sibling at every shipout, and rolls
back on detected source-file edits. Relevant flags:

- (default) **watch mode** — own session loop, rollback on save,
  exits on SIGTERM/SIGINT/SIGHUP.
- `--once` — single compile + exit (fits CI / from-scratch
  rebuild path).
- `--output-directory DIR` — write `.pdf`/`.aux`/`.log` here.
- `--live-shipouts FILE` — append `page<TAB>offset` per shipout.
- `--target-page N` — **declared but explicitly not implemented**
  (CLI errors today). Required for GOAL.md's "stop at viewing
  page" optimisation.
- `--control-fifo`, `--keep-frozen`, `--fork-on-shipout` —
  diagnostic, not needed by the sidecar.

Implications for M3:

1. **No new IPC channel needed for the watch loop itself.** The
   sidecar serialises the project's `Y.Text` to a `.tex` file on
   disk; supertex's own inotify watcher picks up the save and
   rolls back. So our adapter is closer to a "filesystem
   coordinator" than a custom protocol client.
2. **`--live-shipouts` gives us the per-shipout page→PDF-offset
   map** — exactly what we need to chunk the PDF into the
   `pdf-segment` frames the wire format already carries.
3. **`--target-page=N` is the sole upstream PR M3 strictly
   needs.** Without it the sidecar can't honour the "compile
   only as far as the visible page" optimisation, only
   approximate it post-hoc by trimming what we forward.
4. **Cold start.** `supertex` exits on signal but doesn't yet
   serialise its checkpoint state to a single blob — that's a
   separate upstream PR (see "Candidate supertex (upstream)
   work" below) and lives at the M7 boundary, not M3.

### M3 sub-milestones

- [x] **M3.0 — Compiler adapter seam.** _(iter 8.)_ `Compiler`
      interface at `apps/sidecar/src/compiler/types.ts`; `server.ts`
      threads `targetPage` (max viewing page across viewers) through
      it. `FixtureCompiler` preserves prior behaviour.
- [x] **M3.1 — Project filesystem layout.** _(iter 9.)_
      `ProjectWorkspace` (`apps/sidecar/src/workspace.ts`) with
      atomic `writeMain` and strict projectId regex. Server mirrors
      `Y.Text` to `<scratchRoot>/<id>/main.tex` at the head of every
      compile; disposes per-project dirs on close. Mirror is dark
      code until M3.2 reads it.
- [ ] **M3.2 — `SupertexOnceCompiler`.** Spawns
      `vendor/supertex/bin/supertex paper.tex --once
      --output-directory <work>/out --live-shipouts <work>/shipouts`
      per compile call, reads the resulting PDF off disk, returns
      it as a single segment. Slow (full rebuild every edit) but
      end-to-end real. Selected via env var
      `SIDECAR_COMPILER=supertex-once`; default stays
      `fixture` until parity is good.
- [ ] **M3.3 — `SupertexWatchCompiler`.** One persistent
      `supertex` watch process per project; sidecar writes
      `main.tex` and waits for a new shipout entry in
      `--live-shipouts`. Process is reaped on `Compiler.close()`
      with a paired `pgrep`-empty test. Default flipped to
      `supertex-watch` once stable; `fixture` retained behind a
      flag for offline tests.
- [ ] **M3.4 — Per-shipout PDF byte-range deltas.** Use the
      `--live-shipouts` page→offset map to chunk the PDF into one
      `pdf-segment` per *changed* shipout, rather than one big
      segment. Requires tracking the last-shipped offset per
      project across compiles.
- [ ] **M3.5 — `--target-page=N` upstream + sidecar wiring.**
      Open PR against `github.com/jamievicary/supertex` to
      implement the flag. Sidecar passes `targetPage` from the
      `Compiler` request through to the supertex process when the
      flag is supported (feature-detect on startup so older
      supertex builds remain usable).

Cutover is gradual via the `SIDECAR_COMPILER` selector; that
env-var is deleted in M3.5 once `supertex-watch` is the default.
Browser-side M2 has no component tests — Playwright lives in M8.

## Local toolchain

Node 20.18.1 is auto-provisioned per-checkout into `.tools/node/`
(gitignored) by `tests_normal/setup_node.sh`, which the normal
runner invokes. After provisioning Node, the runner calls
`pnpm install --frozen-lockfile --prefer-offline` and then
`pnpm -r typecheck`. pnpm is activated via corepack at the
version pinned in root `package.json` (`packageManager`).

**DrvFs (/mnt/c) workaround.** WSL2 mounts of the Windows
filesystem can't host pnpm's atomic-rename install step
reliably — Windows file watchers (VSCode, antivirus) hold
transient handles that cause `EACCES` mid-install, leaving
half-extracted `_tmp_*` dirs behind. `setup_node.sh` detects
`/mnt/*` checkouts and stashes `node_modules/` under
`~/.cache/tex-center-nm/<sha1-of-checkout-path>/node_modules`
(ext4), then symlinks it back into the checkout. We run
`node-linker=hoisted` (set in repo `.npmrc`) so the layout is
flat enough that Node's resolution algorithm walks the
realpath correctly. On a non-`/mnt/*` checkout the symlink
trick is a no-op and pnpm installs in place.

## Open questions / risks

- **supertex maturity.** `vendor/supertex` is itself in active
  development by the same human; daemon mode and the four
  capabilities listed in `GOAL.md §supertex integration` may not
  exist yet. Plan assumes upstream PRs land in time for M3.
  Mitigation: M1+M2 use a stub compiler so the frontend track isn't
  blocked.
- **Checkpoint blob size and Tigris round-trip.** Cold-start Machine
  must download checkpoint + restore in seconds for the UX to feel
  instant on the second visit. Measure early in M7.
- **Fly Machine cold start vs the "100s of ms" promise.** Hot path
  (Machine already running) is fine; the first edit after wake
  inherits Machine startup. Expectation: latency target applies once
  warm; cold start is a separate, longer event with a UI affordance.
- **Yjs for single-user MVP** is over-engineered, but rewriting for
  collab later is worse. Keeping it.
- **Test strategy.** `tests_normal/` will host fast unit + type
  checks that run on every iteration; `tests_gold/` will host
  end-to-end browser tests (Playwright) and real-supertex compile
  tests. Gold suite will need a way to run headlessly without Fly,
  using Docker Compose.

## Candidate supertex (upstream) work

To be raised as PRs against `github.com/jamievicary/supertex`. None
required for M0–M2. All required by M3.

1. Long-running daemon mode accepting edit ops on stdin or a UNIX
   socket and resuming incrementally.
2. `target_page=N` stop-after-page mode.
3. Per-shipout reporting of PDF byte-range deltas.
4. Checkpoint serialise/restore to a single blob.
