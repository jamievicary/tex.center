# tex.center

A cloud-based LaTeX editor (Overleaf-style) built on **supertex**, an
incremental LaTeX→PDF compiler. Defining feature: edit-to-preview
latency in the hundreds of milliseconds, via supertex's
checkpoint/resume model and an incremental PDF wire format. Live at
https://tex.center. See `GOAL.md` for the full product spec, MVP
acceptance criteria, and architecture.

## Autodev-driven

This project is developed by the **autodev harness** (`./autodev/`),
which loops a Claude engineer agent over the codebase one iteration at
a time. Each iteration: agent edits → `tests_normal` (must stay green,
revert on fail) → `tests_gold` (aspirational, gates `.autodev/finished.md`
but never reverts). Iteration logs are in `.autodev/logs/N.md`; the
living plan is `.autodev/PLAN.md`. See `autodev/CLAUDE.md` for harness
internals.

Provisioning live infrastructure (Fly, Cloudflare DNS, GitHub Actions
secrets, Google OAuth redirect URIs) is **in scope for the engineer**,
not a manual step — credentials live in `creds/` (gitignored).

## Layout

- `apps/` — SvelteKit web frontend + per-project sidecar.
- `packages/` — shared TypeScript packages.
- `src/`, `scripts/`, `deploy/`, `fly.toml` — backend, ops, Fly config.
- `vendor/supertex/` — supertex git submodule (PRs upstream expected).
- `tests_normal/` — must-stay-green suite (Python unittest harness).
- `tests_gold/` — completion-gating suite incl. Playwright live/local specs.
- `.autodev/` — agent state: `PLAN.md`, `logs/`, `discussion/`, `FUTURE_IDEAS.md`.
- `autodev/` — harness clone (separate git repo, gitignored). **Do not edit.**
- `creds/` — live-service credentials (gitignored).

## Conventions

- Work on `main`. No branching.
- `GOAL.md` is read-only for agents.
- Logs in `.autodev/logs/` are append-only; never delete past iterations.
- Both test suites must exit zero before `.autodev/finished.md` may be created.
