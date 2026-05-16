# Future ideas

- **M20.3(a)3 — gate `compiler.warmup()` on workspace `main.tex`
  existing.** Iter 331's warmup hook in `apps/sidecar/src/server.ts`
  `getProject()` spawns the supertex daemon fire-and-forget right
  after the compiler is constructed. On a fresh-project cold start
  `runCompile.writeMain` hasn't materialised `main.tex` on disk yet,
  so the daemon child errors out with
  `supertex: /tmp/.../main.tex: no such file`, the warmup `.catch`
  swallows it, and the iter-331 overlap savings (~4 s of `.fmt`
  load) are forfeit — the first `compile()` then detect-dead-child
  → respawn → wait for ready. Observed in tex-center-sidecar prod
  logs 2026-05-16 (iter 337 investigation). Fix candidates: have
  `ProjectWorkspace.init()` lay down an empty `main.tex` so the
  daemon spawn always finds a file; OR delay warmup until the
  persistence layer's hydration completes (defeats overlap purpose
  unless hydration is fast); OR write a placeholder inside
  `spawnAndWaitReady` itself before `spawnFn`. The
  no-such-file→respawn fallback works, so this is a perf slice, not
  correctness. On stopped→start of a Machine with prior persisted
  state on disk it's a no-op (the file is already there).
- **`--cold` gold flag to exercise the cold-start path explicitly.**
  Once M9.gold-restructure (iter 197) separates warm-up from
  per-spec assertions, the warm path becomes the default and
  cold-start regressions only show up implicitly in the warm-up
  budget. A `--cold` flag that skips the shared warm-up and
  forces each spec to pay first-compile latency would let CI
  measure cold-start as an explicit, named signal. Per
  `.autodev/discussion/196_question.md` final paragraph and
  `196_answer.md` follow-ups.
- **Narrower deploy-scoped `FLY_API_TOKEN` for the control plane.**
  Iter 106 fell back to the personal `creds/fly.token` because
  `flyctl tokens create deploy` is denied for that token's own
  scope. A user-issued deploy token (org-scoped, ≤720h) would be a
  meaningful hardening — the control plane only needs Machines API
  create/start/stop on `tex-center-sidecar`.
- **Source-build the patched lualatex engine.** Iter 75 vendored a
  prebuilt ELF (`vendor/engine/x86_64-linux/lualatex-incremental`)
  built from `jamievicary/luatex-incremental@aa053dd-dirty`. Push
  the maintainer's local uncommitted changes upstream, then either
  pin a submodule at a clean commit and `make` it in a dedicated
  Docker stage (slow but reproducible), or publish release ELFs
  from a GitHub Action and `curl` them in. Reproducibility goal:
  `sha256sum` the bin matches between a clean rebuild and
  what's in the repo.
- **Periodic in-process session sweep.** Boot-time one-shot
  landed iter 258 (gated by `SWEEP_SESSIONS_ON_BOOT=1`). A
  periodic timer (every N hours) inside the same process is the
  next step if deploy cadence slows enough that boot frequency
  alone leaves expired rows lingering.
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
- **Explicit tab-close wire signal → re-enable fast suspend.**
  Iter 343 disabled `suspendStage.arm()` on the viewer-disconnect
  1→0 transition because the 5 s suspend timer raced transient
  cold-reopen WS open-then-close cycles (proxy retry / brief
  upstream blip), and a Fly-suspended Machine cannot be
  auto-resumed by the web proxy's 6PN TCP dial. The cost: a
  closed-tab Machine now stays `started` (RAM allocated) until
  the 5-minute stop timer fires instead of suspending in 5 s.
  Re-enable fast suspend once the client→server WS protocol
  carries an explicit "leaving for good" frame (sent on
  `window.beforeunload` / explicit close, NOT on transient blur
  or network blip). On that frame the sidecar can confidently
  arm `suspendStage`; a re-connection within 300 ms (the design
  case for fast suspend) cancels it as today.
- **File-tree collapse-to-zero chevron.** M12 landed three
  resizable panes with min widths; the original spec called for
  a collapse-to-zero affordance on the tree column with a re-open
  chevron. Deferred from iter 257 for scope. Worth folding into
  a future left-rail UX iteration alongside any project switcher
  / sidebar additions rather than as a stand-alone affordance.
