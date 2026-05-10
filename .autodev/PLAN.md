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

- [ ] **M0 — Repo scaffolding.** Monorepo layout (`apps/web`,
      `apps/sidecar`, `packages/protocol`), TypeScript + pnpm
      workspace, `tests_normal/` runs `tsc --noEmit` + unit tests
      across packages. Submodule already at `vendor/supertex`.
- [ ] **M1 — Static frontend shell.** SvelteKit app: white page with
      "Sign in with Google" button (mock auth for now), three-panel
      editor route stubbed with CodeMirror 6 and a hardcoded PDF in
      PDF.js. No backend yet; serve a fixture PDF.
- [ ] **M2 — Sidecar service skeleton.** Fastify + `ws` server with
      Yjs document persistence in memory, "viewing page N" channel,
      and a stub compile loop that hands back a static PDF to the
      browser. Defines `packages/protocol` (Yjs awareness fields,
      compile messages, PDF byte-range patch messages).
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

M0. Scaffold the monorepo and wire `tests_normal/run_tests.sh` to
run a real (if tiny) check (likely `pnpm -r typecheck`). Land that
before any feature work so subsequent iterations have a place to put
code and a real green-bar to defend.

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
