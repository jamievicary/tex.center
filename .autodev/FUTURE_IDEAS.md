# Future ideas

- **Narrower deploy-scoped `FLY_API_TOKEN` for the control plane.**
  Iter 106 fell back to the personal `creds/fly.token` because
  `flyctl tokens create deploy` is denied for that token's own
  scope. A user-issued deploy token (org-scoped, ≤720h) would be a
  meaningful hardening — the control plane only needs Machines API
  create/start/stop on `tex-center-sidecar`.
- **Unit test `loadOAuthConfig` env-vs-file precedence.** Iter 76
  refactored `apps/web/src/lib/server/oauthConfig.ts` to env-first
  with dev-only file fallback. No targeted unit test today because
  `tests_normal/lib.sh` lacks a temp-dir + env-stash harness for
  ESM/Node code. Add the harness, then test: env-only path, file-
  only dev path, file-ignored-in-prod path, malformed-key paths.
- **Source-build the patched lualatex engine.** Iter 75 vendored a
  prebuilt ELF (`vendor/engine/x86_64-linux/lualatex-incremental`)
  built from `jamievicary/luatex-incremental@aa053dd-dirty`. Push
  the maintainer's local uncommitted changes upstream, then either
  pin a submodule at a clean commit and `make` it in a dedicated
  Docker stage (slow but reproducible), or publish release ELFs
  from a GitHub Action and `curl` them in. Reproducibility goal:
  `sha256sum` the bin matches between a clean rebuild and
  what's in the repo.
- **Session sweeper scheduling.** Storage primitive
  `deleteExpiredSessions(db, now)` landed iter 54; wire it to a
  periodic caller (cron, on-boot pass, or admin route) when one
  exists.
- **Broaden OAuth scope to `openid email profile`.** Today
  `oauthStart.ts:58` requests only `openid email`, so the ID token
  carries no `name` claim and `findOrCreateUserByGoogleSub` defaults
  `display_name` to `''`. Adding `profile` populates display_name
  for real. Cosmetic; unrelated to the iter-131 upsert fix
  (discussion/131 explicitly de-coupled it).
- **In-image Dockerfile smoke before deploy.** Iter 129 had to
  diagnose a production 500 (`Cannot find package 'jose'`) caused
  by adapter-node leaving `jose` external while
  `apps/web/Dockerfile`'s runtime stage shipped no `node_modules`.
  The structural test added that iteration only enforces the
  `COPY --from=builder /prod/node_modules` line — it can't catch a
  `pnpm deploy --prod` that silently produces an empty
  `node_modules`. A CI step that builds the image and runs `node
  -e "import('jose')"` inside it before pushing to Fly, or runs the
  synthetic `/auth/google/callback?error=fake` probe after deploy
  before declaring success, would catch the missed-bundling failure
  class at root. Verified live iter 130.
- **`GET /auth/logout` link affordance.** Today only `POST` works;
  for an email-link or status-page link, a CSRF-protected GET→POST
  shim would be needed.
- **File-tree CRUD verbs.** Create (iter 61), delete (iter 62),
  rename (iter 63), and text upload (iter 66) landed.
- **Binary asset upload.** `upload-file` currently carries
  UTF-8 text only (it populates a `Y.Text`). Images / fonts / PDFs
  need a separate binary-blob channel and a way for the compile
  workspace to read them — design step deferred until the
  per-project Machine model (M7) is in place.
- **Dedicated IPv4 for `tex-center`** once the org leaves trial:
  `flyctl ips allocate-v4 --yes` + rerun
  `scripts/cloudflare-dns.mjs` with the new address. Today the
  apex points at the shared v4 `66.241.125.118` (SNI works).
- **docker-compose bring-up for Postgres + MinIO.** M4.2.1 is
  covered by PGlite for DDL-level checks, but the file-blob side
  of M4.3 (Tigris object store, sidecar hydration round-trip)
  still wants a real local stack. Spin Postgres + MinIO behind a
  compose file with a CI host that has Docker; gold cases gate
  on `which docker`.
