# Root cause was structural, not a postgres-error value to read

## What the real error was

`flyctl logs --no-tail -a tex-center` only surfaces ~100 lines and
the window around `2026-05-12T07:57:37Z` wasn't in the buffer by
the time I queried it. Rather than retry-loop on logs, I proxied
into `tex-center-db` directly and read the `users` table. One row:

```
id:          7d7a970e-b420-46f2-b00e-e5234d8a4c70
email:       jamievicary@gmail.com
google_sub:  probe-jamievicary-livefix
display_name: Jamie Vicary
```

That's the iter-109 deploy-verification seed (`scripts/seed-live-user.mjs:8`,
`creds/live-user-id.txt`). The real OAuth callback arrived with
the same email but `google_sub = 114596996082930464265`. The
upsert's `ON CONFLICT (google_sub) DO UPDATE` branch matches on
`users_google_sub_key`; the new sub didn't match, so PG fell
through to the *next* uniqueness constraint —
`users_email_key (UNIQUE email)` — and raised
`duplicate key value violates unique constraint "users_email_key"`.
That's the error Drizzle's `Failed query:` template masked.

Your hypothesised causes (timestamptz coercion on `$7`,
`default` keyword rejection, drifted constraint) were all
plausible from the params alone but didn't fit the table state.
The "drifted constraint that the Drizzle schema doesn't mirror"
guess was directionally right — except the *Drizzle* schema did
mirror it (`drizzle.ts:24` had `.unique()` on email); the SQL
migration also had it. The constraint was the bug, not a drift.

## Fix landed this iteration

Two pieces, both required:

1. **One-shot UPDATE on the live DB** (already applied via
   `flyctl proxy 5432:5432 -a tex-center-db` + postgres-js):
   `UPDATE users SET google_sub = '114596996082930464265' WHERE
   id = '7d7a970e-…'`. The next OAuth attempt now hits the
   `ON CONFLICT (google_sub)` branch cleanly and refreshes
   display_name in place. `creds/live-user-id.txt` is updated to
   record the new state.

2. **Migration `0002_drop_users_email_unique.sql`** drops
   `UNIQUE (email)`. Reasoning: identity in this schema is
   `google_sub`; email uniqueness wasn't enforcing anything the
   allowlist doesn't (and adds the seed-vs-OAuth collision class
   we just hit). `drizzle.ts:24` lost the `.unique()`;
   `schema.ts:39` comment updated. Will apply to live on next
   deploy via the existing `RUN_MIGRATIONS_ON_BOOT=1` path.

Regression pinned by adding an extra case to
`packages/db/test/users-sessions-pglite.test.mjs`: insert a third
user with the same email as the second but a fresh google_sub,
assert a new row is created (not a 500). Pre-migration that case
would have raised `users_email_key`.

I considered just (1) without the migration — fastest unblock,
no schema churn — but rejected it because the same shape recurs
the moment the seed script runs against a fresh DB whose live
google_sub isn't already known. The migration is the durable
fix; (1) is the no-deploy-window unblock.

I also considered going further and changing the upsert to do
a two-phase lookup-then-update (so it handles arbitrary multi-
constraint collisions). Rejected as gold-plating: once
`UNIQUE (email)` is gone, `ON CONFLICT (google_sub)` is the
only meaningful conflict left, and the upsert is correct.

## What I didn't do

Per your direction:

- Did **not** widen the OAuth scope to `openid email profile`.
  Recording it in `FUTURE_IDEAS.md` as a follow-up: pulling the
  `name` claim is cheap, but it's cosmetic and unrelated to the
  bug.
- Did **not** catch-and-swallow the postgres error. The Drizzle
  `Failed query:` template that masked the underlying detail is
  a separate concern — `oauthCallback.ts:215-222` already
  surfaces the raw error message verbatim to the response body;
  the lossy framing comes from inside Drizzle. If it bites us
  again I'd rather log the postgres-js `Error` directly at the
  upsert site than fight Drizzle's wrapping.

## Plan updates

Promoted the priority milestone block from your question into
`.autodev/PLAN.md`:

- **M8.smoke.0** — Build-time runtime-image smoke test. Next
  ordinary iteration.
- **M8.pw.3** — Real OAuth round-trip via service account.
  After M8.smoke.0 lands.
- **M8.pw.4** — Full product-loop test. After pw.3.

These supersede M7.4.2 and M7.2 as the next-up items. PLAN's
"Current focus" rewritten accordingly. M7.4.2 / M7.5.x are
parked, not deleted; they resume after the priority block.

One judgement call I'll flag here rather than wait for it to bite:
M8.smoke.0 step 2 says `docker run` the production image with
placeholder env vars. That image's entrypoint calls
`bootMigrations.ts` against `DATABASE_URL` before the HTTP listener
binds, so a placeholder URL will either timeout-block or crash.
Will work around either by `RUN_MIGRATIONS_ON_BOOT=0` in the smoke
or by stubbing the resolve target — decide in the iteration that
lands it, not here.

## On the framing

You're right that 77's "out of scope, thin marginal value" was the
wrong call, and that the meta-issue (continuous deployment without
continuous verification) is exactly what the priority block is
designed to fix. I'd add one observation: of the two callback bugs
that shipped, the iter-129 `jose` one would have been caught by
M8.smoke.0 alone (module-load failure on a synthetic GET). This
one wouldn't — it needs M8.pw.3, because the failure is on the DB
path that only fires for a fully-handshaked OAuth response. So the
ordering you proposed (smoke first, pw.3 second) is correct but
the marginal value compounds: smoke catches a strict superset of
the current verification surface; pw.3 adds the rest.
