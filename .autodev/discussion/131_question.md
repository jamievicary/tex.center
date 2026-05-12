# Second callback regression in 24h, and the testing-strategy fix that's been deferred

## New incident (immediate)

The iter-129 `jose` fix worked — the OAuth callback now gets past
module load and through the Google token exchange. **But the next
step, `findOrCreateUserByGoogleSub` inserting/upserting into
`users`, throws.** User-facing error pasted verbatim:

> Session persistence failed: Failed query: insert into "users"
> ("id", "email", "google_sub", "display_name", "created_at",
> "updated_at") values ($1, $2, $3, $4, default, default) on
> conflict ("google_sub") do update set "email" = $5,
> "display_name" = $6, "updated_at" = $7 returning ...
>
> params: 369aa3b8-…,jamievicary@gmail.com,114596996082930464265,
> ,jamievicary@gmail.com,,2026-05-12T07:57:37.378Z

That's the Drizzle wrapper's "Failed query:" template — **it does
not include the underlying Postgres error**. The actual error
shape (code, detail, hint, schema, table, constraint, etc.) is in
the postgres-js exception, which today is being swallowed by
whatever surfaces the user-facing 500. First action: get the real
error via `flyctl logs --no-tail -a tex-center` filtered around
the timestamp `2026-05-12T07:57:37Z`. Don't guess; read the actual
PG error.

Some preconditions already verified by me, so the agent doesn't
need to re-do them:

- OAuth scope in `oauthStart.ts:58` is `"openid email"` — no
  `profile`, so the ID token carries no `name` claim; the
  callback defaults `display_name` to `""`. That's where the
  empty `$4` / `$6` strings come from.
- `displayName` in `packages/db/src/drizzle.ts:26` is
  `text('display_name')` with **no `.notNull()`** — column is
  nullable, so empty-string-vs-null isn't the proximate cause on
  its own.

Plausible specific causes once the PG error is in hand:

- Parameter-type coercion on `updated_at` (the ISO 8601 string in
  `$7` may not match the column's expected timestamp shape under
  the current postgres-js / Drizzle versions).
- A migration applied an unstated constraint that the Drizzle
  schema doesn't mirror.
- `default` keyword inside `values ($1, ..., default, default)`
  being rejected for `created_at`/`updated_at` under the column
  definitions that landed in M4.0/M4.1 vs. what the SQL migration
  actually wrote.
- Something else only `flyctl logs` will reveal.

Fix the real cause. **Do not** ship the obvious wrong fixes:

- Don't swap the OAuth scope to `"openid email profile"` as the
  fix here. Pulling `name` happens to make `display_name`
  non-empty, but the DB insert is failing for a separate reason
  the empty-string masks — the underlying error wouldn't go
  away. Once the real bug is fixed, expanding the scope is fine
  *separately* if you actually want a real display name; record
  it as a follow-up, not a load-bearing change.
- Don't catch-and-swallow the DB error. The agent has the right
  reflexes here from iter 129 ("not auditing other endpoints
  beyond the broad fix") — same posture.

## On the recurrence — the testing-strategy fix

This is **the second consecutive production-down OAuth-callback
bug** to ship through every test layer the project has. iter 76
verified the start leg but not the callback. iter 109's
deploy-verification suite covers `/projects` and `/readyz` but
neither transitively imports `jose` (caught by iter 129) and
neither exercises the callback's DB write (the current bug). The
synthetic `?error=fake` probe iter 129 added to `VERIFY.md`
catches module-load failures but not happy-path failures. So a
*third* callback bug — in a code path one step further into the
handler — would also ship undetected on the current setup.

The earlier `77_question.md` from me framed real-OAuth round-trip
testing as "out of scope, thin marginal value over cookie-injection".
That framing was wrong, and the wrongness has now cost two
production-down incidents in under a day. The agent is not at
fault here — it built what `77_question.md` told it to. This
question revises that scope.

Promote the following to a **priority milestone block** ahead of
any remaining M7.4.x daemon work or FUTURE_IDEAS slices. Land
them in this order, one per iteration unless a slice naturally
combines:

### M8.smoke.0 — Build-time runtime-image smoke test (CI)

Add a step to `.github/workflows/deploy.yml` (or a new
prerequisite job) that:

1. `docker build` the production `apps/web/Dockerfile`.
2. `docker run` the image with the env vars the runtime expects
   (use placeholder values; no real Google or Postgres).
3. Hit every server endpoint with `curl` and assert the response
   is *not* a module-resolution error. Endpoints to probe:
   `/`, `/healthz`, `/readyz`, `/auth/google/start`,
   `/auth/google/callback?error=fake`,
   `/auth/logout` (POST), `/projects`, `/editor/abc123`.
4. Fail the workflow on any module-not-found-class response.

This catches the `jose` class structurally — every prod dep
present in the runtime image is exercised at module load. Cheap,
deterministic, runs on every push without any external
dependencies. Iter 129 flagged this as a future idea; promote it
to next-up-after-the-fix.

### M8.pw.3 — Real OAuth round-trip via service account

Stand up a dedicated Google Cloud service account with the
OAuth client pre-consented on the Google Cloud Console. The
test obtains an ID token via the service account's refresh
token (or its own JWT exchange), constructs a synthetic `code`
that mirrors the real callback's expected payload, and presents
it to `/auth/google/callback` along with a corresponding `state`
cookie. The assertion is that the response is a 302 to
`/projects` and the resulting `tc_session` cookie passes the
session hook.

This is the test that would have caught both the iter-76 `jose`
bug and today's DB-insert bug. Wire into `verifyLive.spec.ts` as
a deploy gate.

### M8.pw.4 — Full product-loop test

The M8 acceptance pass, originally deferred to the end of the
project, brought forward. With M8.pw.3's service-account auth in
hand: a single Playwright spec signs in, creates a project, types
a minimal LaTeX source, waits for a `pdf-segment` frame on the WS,
asserts PDF.js rendered a non-blank canvas. This is the *only*
test that asserts the product does what `GOAL.md` says it does.
Run on a `TEXCENTER_FULL_PIPELINE=1` gate so it doesn't beat on
prod every iter, but **mandatory** on any deploy-touching iter.

## On ordering and priority

The user wrote, with reason, "it's critical to have tests that
cover the full end-to-end pipeline. why is it not taking that
approach?" That's the right frame: continuous deployment without
continuous verification is just continuous regression. The
priority block above takes precedence over M7.4.x supertex daemon
adoption, M7.5.x, and the FUTURE_IDEAS backlog. Don't pause it
for refactor/plan-review iters either — those can resume once the
priority block lands.

If at any point the priority block reveals a deeper structural
issue with how the production image is built or how deploys are
gated, surface it explicitly in a new discussion question rather
than working around it. This class of bug doesn't get fixed by
catching individual instances; it gets fixed by changing the
verification surface.

## On this iteration specifically

Fix the immediate DB-insert bug today. Land M8.smoke.0 next
iteration (it's small and unblocks the rest). M8.pw.3 follows
once M8.smoke.0 is in CI. M8.pw.4 follows pw.3.

Don't try to land more than one of M8.smoke.0 / M8.pw.3 / M8.pw.4
per iteration. Each is meaty enough to deserve its own slot, and
the project has been bitten by over-bundling before (iter 87's
M7.0.2 "manifest + create + deploy" was supposed to be one iter
and ran ~30 min surfacing multiple distinct bugs).
