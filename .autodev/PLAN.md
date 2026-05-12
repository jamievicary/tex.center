# tex.center — Plan

## FREEZE: live product is broken; only the fix proceeds

The live site at https://tex.center is non-functional for the core
loop: login + project list + project open work, but inside the
editor typing doesn't save, the create-file button does nothing,
and the PDF preview never renders.

**Root cause (iter 147 diagnosis):** per-project sidecar Machines
bind only to `127.0.0.1` (`apps/sidecar/src/index.ts:19` defaults
`HOST` to `"127.0.0.1"`), so the control plane's dial against the
Fly 6PN IPv6 address is refused. Probe + Fly log evidence,
including secondary bug in `wsProxy.ts` swallowing dial errors,
written up in `deploy/INCIDENT-147.md`.

**Until `verifyLiveFullPipeline.spec.ts` (M8.pw.4) runs green
automatically on every deploy, no other engineering work
proceeds.** Specifically paused:

- N%10 refactor cron and N%10==1 plan-review cron (resume only via
  explicit edit to this file).
- M7.4.2 (upstream supertex daemon serialise/restore) and all
  post-MVP M7 hardening.
- FUTURE_IDEAS-sourced slices.

Lifting these freezes requires an explicit edit to this section,
not a quiet decision in an iteration log.

## 1. CRITICAL PATH

The remaining work for the user to do all five of:

> 1. Type into an editor → file auto-saves over WS.
> 2. Click "create file" → a new file appears.
> 3. Type a minimal LaTeX doc → PDF renders within ~10 s.
> 4. Refresh the browser → edits persist.
> 5. Return tomorrow → project loads with the same state.

Estimated iteration sequence (adjust as work unfolds):

- **Iter 147 — Diagnose live WS.** *Done.* Authed WS probe to
  `wss://tex.center/ws/project/<owned-id>` returns 502 in ~240 ms
  (Fly-edge synthesised; one `via` hop). Root cause: sidecar
  binds 127.0.0.1 only, 6PN dial refused. Probe script:
  `scripts/probe-live-ws.mjs`. Findings: `deploy/INCIDENT-147.md`.
- **Iter 148 — Fix the broken layer (code).** *Reverted by wallclock
  timeout — re-landed iter 149.* Original plan bundled the
  remote-only sidecar Docker rebuild (≈14 min) plus several
  re-probes inside one iteration; total exceeded 45 min and the
  harness reverted the whole thing.
- **Iter 149 — Re-land iter 148's code-side changes only.**
  *Done.* `apps/sidecar/src/index.ts` `DEFAULT_BIND_HOST = "::"`
  + `resolveBindHost(env)` helper, `apps/sidecar/Dockerfile`
  `HOST=::`, regression locks in
  `apps/sidecar/test/bindHost.test.mjs` (wired via
  `tests_normal/cases/test_node_suites.py::test_sidecar_bind_host`)
  and `tests_normal/cases/test_sidecar_dockerfile.py::test_runtime_listens_on_all_interfaces`
  (flipped to require `HOST=::` and forbid `HOST=0.0.0.0`).
  `apps/web/src/lib/server/wsProxy.ts` writes `HTTP/1.1 502 Bad
  Gateway` to the client on pre-connect `upstream-error` (post-
  connect errors mid-pipe still destroy silently — by then the
  client socket is framed traffic, not HTTP). `apps/web/test/wsProxy.test.mjs`
  Case 4 asserts the 502 + the `upstream-error` event. **Live
  cutover deliberately deferred to iter 150** so the wallclock
  isn't at risk a second time.
- **Iter 150 — Discussion-mode (leaked-subprocess wedge from
  iter 148).** *Done.* Answered `150_question.md`; no engineering.
  Renumbered the cutover + activation slices below.
- **Iter 151 — Fix sidecar CD (it was silently broken).**
  *Done.* Discovered the sidecar deploy workflow has been
  failing since at least iter 124: `actions/checkout@v5` with
  `submodules: recursive` was using the default GITHUB_TOKEN,
  which has no access to the private `vendor/supertex` repo, so
  every sidecar CD run since the supertex repo went private has
  exited at the submodule clone step with `Repository not found`.
  This means the iter-149 bind-host fix never reached the
  production sidecar image. Fix: added `SUBMODULE_TOKEN` repo
  Actions secret (PAT, `repo` scope, sourced from
  `creds/github.token`) and passed it as `token:` on the checkout
  step. Lock-in:
  `tests_normal/cases/test_deploy_sidecar_workflow.py::test_checkout_supplies_submodule_token`.
  The harness commit will trigger CD with the fix in place; the
  new sidecar image will be built at HEAD which already includes
  iter 149.

- **Iter 152 — Fix engine-binary exec bit in git.** *Done.*
  The iter-151 submodule-token fix unblocked the checkout step;
  CD then progressed for the first time ever and surfaced the
  *next* latent bug: the vendored ELF
  `vendor/engine/x86_64-linux/lualatex-incremental` is stored in
  git as mode 100644, so on the Fly remote builder the runtime
  stage's `--ini` fmt-dump fails with `/bin/sh: 1:
  /opt/engine/binary: Permission denied` (exit 126). This bug
  has been latent since iter 75 (when the engine ELF was added);
  it stayed invisible because (a) sidecar CD never reached the
  runtime stage until iter 151's fix and (b) the maintainer's
  WSL filesystem always reports the file as executable
  regardless of git mode, so local docker builds also succeed.
  Fix: `git update-index --chmod=+x
  vendor/engine/x86_64-linux/lualatex-incremental`. Regression
  lock: `tests_normal/cases/test_sidecar_dockerfile.py::test_engine_binary_is_executable_in_git`.
  Cutover slides to iter 153, M8.pw.4 activation to iter 154.

- **Iter 153 — Live cutover.** *Done.* Sidecar CD (run
  25732884801, iter-152 commit) succeeded — first ever green
  `Deploy sidecar to Fly`. Pinned
  `SIDECAR_IMAGE=registry.fly.io/tex-center-sidecar@sha256:5513f7f38b57e3badf0429ba1f319486ad1b44f5ef9c1ea09c91da9f8d4fc0a9`
  on `tex-center`, destroyed two stale per-project Machines
  (185432ef5d9038, 0803d24b6d1e48) that had been OOM-rebooting on
  the old image, ran `scripts/probe-live-ws.mjs` against an owned
  project: **`kind: "upgrade", status: 101`** via TWO `via` hops
  (real upstream response, not Fly-edge synthesis). Iter-147
  WS-502 incident class is **closed**. New per-project Machine
  `d8d545df11d078` running the new image.

- **Iter 154 — Bump per-project Machine memory (code side).**
  *Done.* `apps/web/src/lib/server/upstreamFromEnv.ts`
  `machineConfig` now carries
  `guest: { memory_mb: 1024, cpu_kind: "shared", cpus: 1 }`. Lock-
  in: happy-path block of
  `apps/web/test/upstreamFromEnv.test.mjs` asserts
  `createCall.req.config.guest.memory_mb >= 1024`. The harness
  commit will trigger `Deploy web to Fly` (web CD); once it lands,
  newly-created per-project Machines come up at 1GB. Pre-existing
  Machine `d8d545df11d078` (from iter-153 probe) is still 256MB
  and needs destroying so the resolver recreates it at the new
  size — that's an iter-155 operational step.

- **Iter 155 — Destroy stale per-project Machine + re-probe.**
  *Done.* Waited for iter-154 `Deploy to Fly` (run 25733765835) to
  finish before destroying so the recreated Machine would pick up
  the 1024MB guest config (not the old 256MB default). Destroyed
  `d8d545df11d078`. Resolver recreated `48e3376f957e18` at
  `shared-cpu-1x:1024MB`. Third probe (after Machine reached
  `started`) returned `kind: "upgrade", status: 101` via two `via`
  hops in 633ms. First live confirmation iter-154 memory bump
  reached production. Payload-bearing probe extension deferred to
  iter 156 (requires writing a small WS client; not a trivial probe
  tweak).

- **Iter 156 — Payload-bearing WS probe (code-side).** *Done.*
  Added `scripts/probe-live-ws-payload.mjs`: a sibling to
  `probe-live-ws.mjs` that uses the `ws` client (not raw
  `node:https`), keeps the WS connection open after upgrade,
  decodes leading frames with `@tex-center/protocol`'s
  `decodeFrame`, asserts the sidecar's `hello` control + `file-
  list` arrive, sends a `view` control frame back upstream, and
  holds the socket open for 3s after `file-list` to confirm
  upstream doesn't immediately close (cgroup-kill / framing
  error). Hard timeouts on every wait. Root `package.json` gained
  `@tex-center/protocol`, `ws`, `@types/ws` so the probe is
  runnable from the project root via `pnpm exec tsx`. Live
  invocation deferred to iter 157 (operator step — needs `flyctl
  proxy` + creds; same recipe as iter 153/155 reuses).

- **Iter 157 — Run payload-bearing probe live (stretch 1).** *Done.*
  `flyctl proxy 5435:5432 -a tex-center-db` (bg, killed at end),
  exported `DATABASE_URL` (postgres superuser via 127.0.0.1:5435),
  `SESSION_SIGNING_KEY=RtO0ubMW…wDY`,
  `TEXCENTER_LIVE_USER_ID=7d7a970e-…4c70`, ran
  `pnpm exec tsx scripts/probe-live-ws-payload.mjs`. First call
  502 (4.3s, resolver mid-cold-start); second call after
  resolver settle: **`kind: "ok"`, upgraded, helloSeen, fileListSeen,
  docUpdateSeen, files=["main.tex"], 3.4s, 0 decode errors, no
  early close.** First live confirmation the sidecar's full
  framed-payload path (control hello + initial Yjs state +
  file-list + doc-update) works end-to-end at the 1024MB runtime
  floor. Project: `ae011b9e-e287-4d62-98ff-d0187ac44dd1` (existing,
  owned by live user). Proxy PID killed cleanly, port 5435 closed.

- **Iter 158 — Wire M8.pw.4 into the deploy workflow.** *Done.*
  Pushed three GitHub Actions secrets to
  `jamievicary/tex.center` via `gh secret set`:
  `TEXCENTER_LIVE_DB_PASSWORD` (Fly Postgres superuser, from
  `creds/fly-postgres.txt`), `SESSION_SIGNING_KEY` (from
  `creds/session-signing-key.txt`), `TEXCENTER_LIVE_USER_ID`
  (from `creds/live-user-id.txt`). Added a `live-pipeline` job to
  `.github/workflows/deploy.yml` that `needs: deploy`, sets up
  Node 20 + pnpm via corepack + flyctl, installs Playwright
  chromium, and runs `pnpm exec playwright test --config
  tests_gold/playwright.config.ts --project=live` with
  `TEXCENTER_LIVE_TESTS=1`, `TEXCENTER_FULL_PIPELINE=1`,
  `PLAYWRIGHT_SKIP_WEBSERVER=1`, and the three new live env vars
  + `FLY_API_TOKEN` threaded through. Regression lock:
  `tests_normal/cases/test_deploy_workflow.py::test_live_pipeline_job_runs_full_pipeline_spec`.
  The harness commit will trigger CD and the new
  `live-pipeline` job will run M8.pw.4 against the live
  deployment for the first time. **Note on operator-gated specs:**
  The PLAN had previously conflated M8.pw.4 activation with
  M8.pw.3.3's TEST_OAUTH_BYPASS_KEY operator step; they are
  unrelated. M8.pw.4 uses cookie injection via `authedPage`, no
  OAuth round-trip; M8.pw.3.3 (real-OAuth callback,
  `verifyLiveOauthCallback.spec.ts`) still self-skips on
  missing `TEST_OAUTH_BYPASS_KEY` and remains operator-gated —
  but that no longer blocks M8.pw.4 or the FREEZE-lift gate.

- **Iter 159 — First live-pipeline run revealed a 155-iter-old
  bug.** *Done.* Iter 158's harness commit (`7a0263a`) triggered
  the first ever `live-pipeline` execution. It failed at
  `pnpm install --frozen-lockfile` with `ERR_PNPM_ENOENT` on
  `node_modules`. Root cause: `node_modules` had been tracked as
  a *symlink* in git since iter 4's commit `23513e5`; on the
  maintainer's WSL2 working tree `setup_node.sh` retargets it at
  `$HOME/.cache/tex-center-nm/<hash>/node_modules` to dodge DrvFs
  handle races, but on a clean GH runner the target doesn't exist
  so `checkout` lays down a dangling symlink and pnpm's
  `mkdir node_modules` ENOENTs. Latent until iter 158 because the
  previously-existing `smoke` and `deploy` jobs both build inside
  Docker (smoke) or on Fly's remote builder (deploy) — neither
  runs `pnpm install` directly on a runner. Fix:
  `git rm --cached node_modules`. Lock:
  `tests_normal/cases/test_no_tracked_node_modules.py` —
  `test_no_node_modules_tracked` and
  `test_no_tracked_symlinks_outside_vendor` (more general — any
  tracked symlink outside `vendor/` fails, since they almost
  always encode maintainer-local absolute paths).
- **Iter 160+ — Confirm live-pipeline runs green automatically,**
  then lift the FREEZE in this file's header. If the live run
  reveals a real regression, fix it (that is precisely the
  protection the freeze exists to enforce); if it reveals a flake
  or env-shape mismatch in the wiring, fix the wiring and re-run.
  Operator-gated work that remains (M8.pw.3.3 activation: GCP
  console + `scripts/google-refresh-token.mjs` +
  `TEST_OAUTH_BYPASS_KEY` Fly secret) is *not* on the
  FREEZE-lift critical path.

- **Iter 162 — Discussion mode (live user-flow gaps).** *Done.*
  Answered `162_question.md`. Human report: typing into the
  editor on https://tex.center produces no PDF preview, and no
  save-state affordance exists. Corrected the question's premise:
  M8.pw.4 has never run green automatically (158/159/160 failed at
  infra layers, 161 in flight at answer-time), and iter-157's
  manual probe only exercised the **read-only** half of the pipe
  (hello + file-list + initial state). The "edit → pdf-segment"
  path has never been confirmed live. Sequencing for next slices
  below.

- **Iter 163 — Read iter-162 result + add observability.** *Done.*
  iter-161 live-pipeline (run 25737092129, the first deploy
  containing the iter-161 DB-name default fix) was the first
  run to actually reach M8.pw.4. Result: **branch (b)** — spec
  failed with `no pdf-segment frame received within timeout`
  (240_000ms). Crucially the sidecar's per-project Machines
  (`e829704ae25658`, `d8d329da16e738`) for the spec window
  13:22–13:26Z reached "Server listening at http://[::]:3001"
  but emitted **zero `incoming request` lines** for
  `/ws/project/<id>` — the dial either didn't reach them or
  failed before reaching them.

  Production had no diagnostic trail because
  `apps/web/src/server.ts` passed **no `onEvent`** to
  `attachWsProxy`, and `boot.ts` didn't even forward an option.
  Every `resolve-error` / `upstream-error` / `auth-error` /
  `closed` evaporated. Iter 163 fixed the observability gap on
  both sides of the proxy:
  - `apps/web/src/lib/server/boot.ts`: added `onWsProxyEvent`
    to `BootOptions`, forwarded to `attachWsProxy`.
  - `apps/web/src/server.ts`: supplies a `console.log` shim
    emitting one-line JSON per WS-proxy lifecycle event.
  - `apps/sidecar/src/server.ts`: info-level logs on client
    `doc-update` arrival; compile start (with sourceLen);
    compile ok (elapsedMs / segments / bytesShipped) or
    compile error.
  - Regression lock in `apps/web/test/boot.test.mjs`:
    asserts `onWsProxyEvent` plumbing receives both `no-match`
    (from the /nope upgrade) and `upstream-connect`(ed) (from
    the /ws/project/ upgrade).

  No fix to the actual loop in this iteration — diagnosis was
  the wrong layer (no logs). The harness commit triggers a new
  deploy whose live-pipeline result is now diagnosable from
  `flyctl logs`.

  Secondary find: unrelated `projects.spec.ts` empty-state
  test also failed in CI because the live user has accumulated
  projects from probes. Not critical-path; deferred.

- **Iter 164 — Read iter-163's live-pipeline + diagnose with logs.**
  With WS-proxy events and sidecar Yjs/compile logs now flowing,
  re-read the deploy's live-pipeline result + `flyctl logs -a
  tex-center` (web) + `flyctl logs -a tex-center-sidecar`
  (sidecar) for the spec window. The cause separates into:
  - **No `upstream-connect` event** for the project's WS:
    auth deny / resolver failed before producing an upstream.
    Look for `auth-error` / `resolve-error` / `unauthorised`.
  - **`upstream-connect` but no `upstream-connected`** within
    the proxy's connect timeout: dial reached an unreachable
    Machine address. Compare resolver-chosen address vs.
    Machine's actual 6PN IP.
  - **`upstream-connected` but no sidecar `incoming request`**:
    pipe established to wrong address (a stale Machine still
    listening from a previous deploy).
  - **Sidecar `incoming request` but no `client doc-update`**:
    Yjs frames aren't reaching the sidecar through the proxy.
  - **`client doc-update` but no `compile ok`**: compile
    failure inside `SupertexDaemonCompiler` (engine error /
    spawn failure / round timeout) — error log will say which.
  - **`compile ok` but client doesn't render**: PDF.js path
    on apps/web's `Preview.svelte`. Browser-side bug.

  Land the actual fix + regression spec covering the precise
  failure shape. For "no sidecar incoming request" specifically,
  also add an "existing-project edit" variant of M8.pw.4 that
  reuses a pre-seeded fixture project owned by the live test
  user — the seeded-fresh vs reused-existing path divergence
  remains a known coverage hole.
- **Iter 165+ — Save-feedback affordance.** New `SyncStatus`
  indicator in `apps/web`. Three visual states (idle/"Saved",
  in-flight/"Saving…" with 250ms tail debounce, error/"Save
  failed" persistent). Source of truth: Yjs provider sync state
  acked by sidecar persistence layer, NOT per-keystroke. Tests:
  pure state-machine unit test, local Playwright spec covering
  the three transitions including server-side WS drop for the
  error state, live variant under `TEXCENTER_LIVE_TESTS=1`
  asserting "Saved" reached within a generous window after
  typing on the live site. Blocked on iter 164's green.

**FREEZE-lift criterion refined (per `162_answer.md`):** the
freeze now lifts only when (a) M8.pw.4 runs green automatically
AND (b) the edit→pdf-segment path has been exercised against a
**reused pre-existing project**, not just a fresh seed. The
iter-162 user report demonstrated that spec-green alone can
co-exist with a broken user flow if the spec's project-lifecycle
assumptions diverge from real usage.

  **Leaked-subprocess hygiene (per `150_answer.md`):** do NOT
  invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`, `watch`,
  or any daemon-style command via Bash without `timeout
  --kill-after=2 Ns …` wrapping, or `run_in_background:true`
  paired with an explicit kill before iteration end. Never pipe
  such a command into a downstream that waits for EOF (`… | tail
  -N`, `… | head`). That pipeline shape is what wedged iter 148.

After M8.pw.4 passes green automatically, the freezes above may
be lifted via an explicit edit here.

## 2. Per-area current state

- **Auth.** OAuth callback live, allowlist `jamievicary@gmail.com`
  enforced, session persistence in Postgres, M8.pw.3 cookie-
  injection + real-OAuth-round-trip code paths complete.
  *Open:* M8.pw.3.3 activation (operator-gated test OAuth client
  in GCP).
- **Editor (apps/web).** Three-pane SvelteKit shell, projects
  dashboard, file-tree CRUD UI, OAuth-gated routes, WS proxy
  (`wsProxy.ts`) with byte-level forwarding and per-project access
  gate (`wsAuth.ts`). *Open:* WS connection failing in prod (see
  CRITICAL PATH).
- **Sidecar (apps/sidecar).** Fastify + ws + Yjs, per-file
  hydration + persistence, `SupertexDaemonCompiler` shipping PDFs
  locally, idle-stop wired. Per-project Fly Machines via
  `flyMachines.ts` + `upstreamResolver.ts`. *Open:* prod-side WS
  not delivering frames.
- **Deployment.** Control plane (`tex-center`) and sidecar
  (`tex-center-sidecar`) on Fly in `fra`, scale-to-zero, CD on
  push to main with smoke job gating deploy, OAuth secrets +
  Postgres + Tigris attached, migrations on boot, custom domain
  via Cloudflare. *Open:* full-pipeline spec not yet activated.
- **Testing.** `tests_normal/` unit + type checks green;
  `tests_gold/` Playwright local-target green; `verifyLive.spec.ts`
  runs on deploy (`TEXCENTER_LIVE_TESTS=1`); M8.pw.3.3 and M8.pw.4
  code-side complete but operator-gated. *Open:* M8.pw.4
  activation — the test that would have caught the current
  breakage.

Completed milestones: **M0–M7.5.5** plus **M8.pw.0–M8.pw.3.2** and
**M8.smoke.0** (see git log + earlier iteration logs for the
detail). Live deploy + per-project Machine spawn fully wired.

## 3. Open questions

- M8.pw.3.3 live activation: needs operator to create the test
  OAuth client in GCP (redirect `http://localhost:4567/oauth-
  callback`), run `scripts/google-refresh-token.mjs`, push
  `TEST_OAUTH_BYPASS_KEY` via `flyctl secrets set`.
- M7.4.2 — upstream supertex daemon serialise/restore wire (PR
  against `github.com/jamievicary/supertex`). Gates checkpoint
  persistence ever doing anything observable. **Deferred until
  MVP unblocked.**
- M7.5 daemon adoption remaining slices and post-MVP M7 hardening
  (rate limits, observability, narrower deploy tokens). **Deferred
  until MVP unblocked.**
- Per-project Fly Machines vs current shared sidecar model: decision
  deferred to post-MVP.
- FUTURE_IDEAS items: see `.autodev/FUTURE_IDEAS.md`; **frozen**
  pending MVP unblock.
