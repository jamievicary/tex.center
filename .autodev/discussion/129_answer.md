# 500 on `/auth/google/callback` — root cause: `jose` missing from runtime image

## Diagnosis

Treated as production-down per the question. Live probes:

- `GET /healthz` → **200** `{"ok":true,"protocol":"tex-center-web-v1"}`
- `GET /readyz` → **200** `{"ok":true,"db":{"state":"up"}}`
- `GET /` → **200**
- `GET /auth/google/callback?error=fake` → **500** (SvelteKit default
  HTML error page, not the route's own 400 branch)

`/readyz` reporting `db: up` rules out the DB-side hypotheses from the
question (DATABASE_URL unset / Postgres unattached / migrations
unapplied). It also rules out the iter-95 custom-Node-entry-eating-
errors theory: errors *are* being propagated; the SvelteKit default
500 page is rendered. The DB is fine, the entry is fine. The fault is
inside `/auth/google/callback` specifically.

`flyctl logs --no-tail -a tex-center` shows the stack on every callback
hit:

```
[500] GET /auth/google/callback
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'jose' imported from
  /app/build/server/chunks/_server.ts-BPvntyXL.js
    at packageResolve (node:internal/modules/esm/resolve:854:9)
    ...
```

`jose` is the only thing `apps/web/src/lib/server/googleTokens.ts`
imports (used for `createRemoteJWKSet` + `jwtVerify` of the Google ID
token). The callback's module graph reaches `jose` even on the
`?error=fake` branch because SvelteKit eagerly loads `+server.ts` and
its imports; the early-return `if (queryError !== null …)` never gets
a chance to run because module evaluation throws first.

## Why this has been latent forever

`apps/web/Dockerfile`'s runtime stage carries only `/repo/apps/web/build`
and a one-line `package.json` declaring `{"type":"module"}`. The
comment claims "adapter-node bundles all third-party deps into
apps/web/build/, so the runtime stage carries only that directory plus
Node itself — no node_modules, no pnpm." **That comment is wrong.**

adapter-node's Rollup pass treats anything under `node_modules` as
external; the import literal `import { … } from "jose"` is preserved
verbatim and resolved at runtime against `node_modules`. With no
`node_modules` in the runtime image, the resolution fails the first
time a module-graph branch reaches `jose`.

Workspace deps (`@tex-center/auth`, `@tex-center/db`,
`@tex-center/protocol`) are symlinks and therefore *do* get inlined by
Vite as if they were repo-local source — that's why `/readyz` (which
uses drizzle via `@tex-center/db`) works despite drizzle also being a
node_modules package. drizzle is reached only through the workspace
`@tex-center/db` indirection, whose source got inlined; `jose` is
imported directly and stays external.

Crucially: this is not a regression in any recent iteration. **The OAuth
callback path has been broken on every deploy since auth went live.**
iter 76 verified the *start* leg of the handshake (302 to Google's
consent screen) but the question itself notes the callback was never
fully exercised live. The deploy-verification suite landed in iter 109
covers `/projects` and `/readyz`, neither of which transitively imports
`jose`, so the failure stayed invisible.

## On the question's hypotheses

- **DATABASE_URL unset / Postgres unattached** — ruled out, `/readyz`
  reports `db: up`.
- **iter-105 migrations failing** — ruled out, deploy logs show
  `migrations: 0 applied, 1 already present`.
- **iter-95 custom Node entry eating errors** — ruled out, SvelteKit's
  default 500 page is rendered (a bare-500-with-no-page would point at
  the entry).
- **Google Cloud Console redirect-URI mismatch** — would surface as a
  Google-side error page, never reaching us; the 500 is same-origin
  with `server: Fly/...` headers.

So the question's "verify before fixing" pruning saved a chunk of
guesswork — the readyz/healthz probe and the `?error=fake` synthetic
probe together pointed straight at the bug.

## Fix

This iteration:

1. **Dockerfile** — install prod-only deps via `pnpm deploy
   --filter @tex-center/web --prod /prod` in the builder, then
   `COPY --from=builder /prod/node_modules ./node_modules` into the
   runtime stage. `pnpm deploy` is the canonical pnpm command for
   producing a self-contained deployable directory; it resolves
   `workspace:*` to copies, prunes devDeps, and respects the lockfile.
2. **Comment** — replace the "no node_modules" comment with the real
   reason node_modules has to be present (adapter-node leaves npm deps
   external).
3. **Regression test** — `test_web_dockerfile.py` gains
   `test_runtime_carries_prod_node_modules` asserting the runtime stage
   contains a `COPY` of a prod `node_modules` directory from the
   builder. Pins the invariant cheaply, with no docker available.
4. **VERIFY.md** — add the `GET /auth/google/callback?error=fake` →
   302-to-`/` probe (or 400 with state-cookie cleared) as a hard gate.
   This is the synthetic-probe step the question explicitly asked for,
   and it would have caught this bug if it had existed in iter 76.
5. **PLAN.md** — note the incident under live caveats and link this
   answer.

I'm not redeploying from here (the agent doesn't run `flyctl deploy`
outside of CI). The harness commits to `main`; the `Deploy to Fly`
workflow at `.github/workflows/deploy.yml` redeploys on every push, so
the fix goes live on the next iteration's commit.

## What I'm explicitly not doing

- Not extending the synthetic probe to a full OAuth round-trip
  driven by Playwright. As noted in the question, consent-screen
  driving stays out of scope; the `?error=fake` probe exercises the
  full module graph + handler entry, which is sufficient regression
  protection.
- Not auditing other server endpoints for stray `node_modules` imports
  beyond `jose`. The `pnpm deploy` fix installs *all* prod deps, so
  the fix is broad even if I haven't enumerated which other ones were
  latent landmines. The workflow's next pre-deploy invariant would be a
  Docker-build-in-CI step that smoke-tests the runtime image — flagged
  in FUTURE_IDEAS once this lands.
- Not changing the auth code itself. The route is fine; the missing
  bundle layer is what's wrong.

## Commitments for future iterations

- After the next deploy: re-run `verifyLive.spec.ts` with
  `TEXCENTER_LIVE_TESTS=1` and confirm the new callback probe passes
  alongside the existing five.
- If the next deploy still 500s the callback (i.e. `pnpm deploy`
  didn't pull `jose` in for some reason), the next iteration ssh's
  into the Machine, lists `/app/node_modules`, and either widens the
  copy or pins a deeper bug.
- M8.pw.2 carry-forward (live `authedPage` driving `/projects`
  post-callback assertions) stays as written; it's the long-term
  catch-this-class-of-regression fixture.
