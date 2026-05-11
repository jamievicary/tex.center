# Answer — bring M8 Playwright forward

## Agreement on the motivation

Agree. Iter-73's `/healthz`+`/` probes passed while OAuth was
broken because the bug was on a code path no HTTP probe was
exercising. The cleanest fix in the long run is a layer of tests
that drive the same surface a human does. M8.pw.0 → pw.1 → pw.2
is the right shape and the right size.

## Where I'd adjust the priority claim

The question argues "land before M7.0.1+ because every additional
deploy without UI verification risks another OAuth-class bug".
M7.0.1 is already landed (iter 75, engine ELF vendoring). The
remaining M7.0 work is:

- **M7.0.2** — `flyctl deploy` of a *new* Fly app
  `tex-center-sidecar`. This is internal-only (6PN, no public IP);
  it does not re-roll the `tex-center` control-plane image and is
  invisible to any browser test.
- **M7.0.3** — control-plane WS proxy. This *does* re-roll the
  control plane.

So the strict-ordering claim is "Playwright before M7.0.3", not
"Playwright before M7.0.2". The two are independent — M7.0.2 can
sit in front of, behind, or alongside M8.pw.0/1 without affecting
the OAuth-class-bug argument. That said, I agree with the spirit:
get pw.0+pw.1 landed before the next *control-plane* deploy, and
M7.0.3 is the next one of those. Concrete ordering I'm
committing to:

1. **M8.pw.0** — next ordinary iteration (was M7.0.2).
2. **M8.pw.1** — immediately after.
3. **M7.0.2** — slot here. Doesn't touch the control plane, so
   pw doesn't apply; pure sidecar deploy.
4. **M8.pw.2** — wire the `live` suite into the deploy template
   before M7.0.3.
5. **M7.0.3** — control-plane redeploy with `live` suite as part
   of acceptance.

## On the three slices

### M8.pw.0 — skeleton

Agree on every point. Specifics I'll commit to:

- `.tools/playwright/` for the browser bundle, gitignored,
  provisioned by a new `tests_gold/setup_playwright.sh` that
  mirrors `tests_normal/setup_node.sh`'s shape (idempotent,
  re-run = no-op).
- **DrvFs note.** `setup_node.sh` already symlinks
  `node_modules → ~/.cache/tex-center-nm/<hash>/node_modules`
  on `/mnt/*` checkouts because pnpm's atomic-rename install
  loses to Windows file watchers. Playwright's browser install
  does the same kind of `rename(2)` dance, so I'll apply the
  same indirection: on `/mnt/*`, `.tools/playwright` becomes a
  symlink to `~/.cache/tex-center-pw/<hash>/`. Verify the install
  before declaring pw.0 done.
- `tests_gold/playwright.config.ts` with `live` + `local`
  projects; only `local` declares a `webServer:` block that boots
  `pnpm --filter @tex-center/web dev`.
- The first test asserts the GOAL.md criterion #1 invariant
  precisely: DOM contains exactly one button with the "Sign in
  with Google" text, no marketing copy, no hint paragraph.
- `tests_gold/cases/test_playwright.py` shells out to
  `pnpm exec playwright test --project=local`. The gold runner
  already does this `pnpm exec tsx`-style for the PGlite cases,
  so the pattern carries.

### M8.pw.1 — session injection

Agree on the cookie-injection workaround over real OAuth driving.
Two pushbacks on the live-target plumbing:

- **DB writes against prod Postgres need a teardown path.** The
  question's plan is `flyctl proxy 5433:5432 -a tex-center-db`
  + INSERT into `sessions`. Fine in principle, but the test must
  DELETE its row in `afterAll`, and the test ID must be
  recognisable so a half-killed run can be swept up by hand.
  I'll use a fixed `kind: 'pw-test-<random>'`-style marker on
  the cookie payload (or a `WHERE expires_at < now()` cleanup at
  the start of each run) so abandoned rows don't accumulate.
  The sessions table has a `deleteExpiredSessions` sweeper
  already (iter 54); minting with a `expires_at = now() + 5min`
  TTL means even a forgotten row self-cleans within minutes.
- **Prod-DB-during-test as a moving part.** This adds `flyctl
  proxy` to the live-suite preconditions — a separate process
  with its own failure mode (port already in use, proxy crash,
  DNS hiccup). Acceptable for now (the alternative — a
  test-only admin endpoint — is more code and more attack
  surface), but worth flagging that a single flake in `flyctl
  proxy` will look like a Playwright flake. The proxy launcher
  will live in `tests_gold/lib/flyProxy.ts` with a clear health
  check so failure modes are attributable.

Agree on the first wave of four authed tests; nothing to add.

### M8.pw.2 — deploy-iteration verification

Agree. `TEXCENTER_LIVE_TESTS=1` gate plus extending
`deploy/VERIFY.md` is the right shape. One refinement: the gold
case should `exit 0` (pass) when the env var is unset, with a
clear "skipped because $TEXCENTER_LIVE_TESTS unset" log line, so
the default `tests_gold` run stays clean.

## Out of scope — agree

Real OAuth consent-screen driving is correctly deferred. The
HTTP-handshake check (302 to accounts.google.com, no
`redirect_uri_mismatch`) is what `deploy/VERIFY.md` probe 3
already does; that's the operational signal. Cookie injection
covers everything past `/`.

## Plan changes I'm landing this iteration

- **M8 broken into M8.pw.0 / pw.1 / pw.2 + the full acceptance
  pass.** The acceptance pass stays the M8 endpoint; pw.0–2 are
  prerequisites that ship between now and M7.0.3.
- **Current-focus pointer:** next ordinary iteration is M8.pw.0,
  not M7.0.2.

I'll update PLAN.md in this iteration so the next pickup is
unambiguous. No code changes — the implementation work is the
next iteration.

## Files touched this iteration

- `.autodev/discussion/77_answer.md` — this answer.
- `.autodev/PLAN.md` — M8 decomposed; current-focus repointed.
- `.autodev/logs/77.md` — discussion-mode goal section.

## Tests

`bash tests_normal/run_tests.sh` before terminating. No code
changed, so this is a pure regression check that the harness
hasn't drifted.
