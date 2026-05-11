# Bring M8 Playwright forward

## Motivation

The iter-73 M6.3.1 deploy was declared successful on the strength
of HTTP probes against `/healthz` and `/`, but the live OAuth
flow was actually broken (see `76_question.md`). That failure
mode is the canonical case for E2E browser testing: a real user
clicking the only button on the page hits a server-rendered
error a `curl` probe never sees. PLAN.md has had "Playwright
lives in M8" as a forward reference for many iterations; that
reference should move forward to **now**, so every future
deploy-touching iteration has a programmatic way to verify the
UI before declaring done.

This is not a rewrite of M8 — the full acceptance pass against
the seven GOAL.md criteria still belongs there. What's being
pulled forward is the **infrastructure** to author and run
browser tests, plus a small first wave of tests covering the
auth-gated editor surface.

## Suggested decomposition

Land as three sub-milestones. Don't try to ship all of this in
one iteration.

### M8.pw.0 — Playwright skeleton

- Add `@playwright/test` as a workspace devDep (use the same
  pnpm patterns already in `apps/web` / `apps/sidecar`).
- Install Chromium into the local toolchain
  (`PLAYWRIGHT_BROWSERS_PATH=.tools/playwright npx playwright
  install chromium` so it lives alongside Node under
  `.tools/`, gitignored, provisioned by
  `tests_normal/setup_node.sh`-style script).
- Create `tests_gold/playwright.config.ts` with two project
  targets:
  - `live` — `baseURL: https://tex.center`, used by deploy
    iterations.
  - `local` — `baseURL: http://localhost:5173` (or whatever the
    `apps/web` dev server uses), used by ordinary iterations.
- One trivial test: hit `/` with no cookies, assert the page
  contains the sign-in button text and *only* the sign-in button
  text (verifies GOAL.md acceptance criterion #1's
  "no marketing copy, no hints" clause — already covered by HTTP
  probes for the bytes, but the DOM assertion is sharper).
- Wire into `tests_gold/cases/test_playwright.py` so the runner
  picks it up.

### M8.pw.1 — Session-cookie injection + authed surface

The blocker for testing anything past `/` is that the real OAuth
round-trip requires human consent on the Google screen. The
clean workaround: mint a synthetic session cookie at test time
using the same `SESSION_SIGNING_KEY` the server verifies with.

- A `tests_gold/lib/mintSession.ts` helper that takes the
  signing key (from env `SESSION_SIGNING_KEY`, sourced via
  `flyctl secrets list --app tex-center --json` for the `live`
  target, or from `creds/` / a local env for `local`), inserts
  a fresh `sessions` row for the allowlisted user, signs the
  cookie, and returns it.
- Playwright fixture `authedPage` that calls the helper and
  `page.context().addCookies(...)` before the test runs.
- First wave of authed tests (just a few, the point is the
  fixture works):
  - `/` redirects to `/editor` when authed (covers iter 53).
  - `/editor` renders the three-panel layout (file tree element,
    CodeMirror editor element, PDF viewer element all present in
    the DOM).
  - `/projects` lists the user's projects (covers iter 68).
  - Sign-out POST clears the cookie and lands back on the white
    `/` page.

For the `live` target: the session-row insert requires a DB
connection. Either expose a minimal admin endpoint guarded by a
short-lived bearer token (over-engineering for MVP), or have
the test runner connect directly to Fly Postgres via a proxy
(`flyctl proxy 5433:5432 -a tex-center-db`) and insert the row,
then clean up after. The proxy approach is fewer moving parts.

### M8.pw.2 — Deploy-iteration verification

- Extend `deploy/VERIFY.md` (from `76_question.md`) to require
  the `live`-target Playwright suite to pass as the
  deploy-success signal — not just curl probes.
- Update the deploy-touching iteration template / process in
  `engineer.md`-equivalent state so future M6.x / M7.x iterations
  re-run the `live` suite at the end.
- Add a `tests_gold` case that runs the `live` suite only when
  an explicit `TEXCENTER_LIVE_TESTS=1` env var is set (so the
  default `tests_gold` run doesn't beat on production every
  iteration), but does run automatically inside iters tagged as
  deploy-touching.

## Real OAuth round-trip — explicitly out of scope

Driving Google's consent screen headlessly requires a service
account with one-time-granted consent and is a sizeable piece of
work with thin marginal value over the cookie-injection approach
above. Leave it for M8 proper if it's ever needed; for MVP, the
HTTP-level handshake check from `76_question.md` (verify
`/auth/google/start` 302s to `accounts.google.com` without a
`redirect_uri_mismatch`) plus the cookie-injection-authed editor
tests cover the surface a human-driven smoke test would catch.

## Constraints and gotchas

- **Chromium bundle is ~200 MB.** Cache it under `.tools/` like
  Node (see `tests_normal/setup_node.sh` for the pattern) so
  iterations don't re-download. Gitignore the path. Verify the
  install survives the WSL `/mnt/c` DrvFs workaround that the
  Node bundle uses (it might need the same
  `~/.cache/tex-center-…` indirection on `/mnt/*` checkouts —
  Chromium's atomic-rename steps are similarly fragile).
- **Test runtime budget.** The full Playwright suite must stay
  comfortably inside the 45-minute iteration wallclock. Keep the
  initial suite small; one passing test in M8.pw.0, four or five
  in M8.pw.1. Heavier scenarios can come later.
- **Flakiness discipline.** Use `await expect(locator).toBeVisible()`
  with default timeouts, not `page.waitForTimeout(…)`. Any test
  that flakes should be quarantined immediately and fixed in the
  next iteration rather than retried.
- **Local target's dev server.** `apps/web` is adapter-node now;
  the test runner needs to know whether to start `pnpm dev`
  itself or assume the user has it running. The standard
  Playwright `webServer:` config block in
  `playwright.config.ts` handles this — set it up so the
  `local` target boots the dev server, and the `live` target
  doesn't.

## Priority

Higher than M7.0.1+ (further sidecar Dockerfile work) for one
reason: every additional deploy without UI verification is a
chance to ship another OAuth-class bug into production. Land
M8.pw.0 next, then M8.pw.1 immediately after, then M8.pw.2,
then resume M7.0.
