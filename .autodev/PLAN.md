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

- **Iter 157 — Run payload-bearing probe live + activate M8.pw.4.**
  Two stretches:
  1. Operator step: `flyctl proxy 5435:5432 -a tex-center-db`,
     export `DATABASE_URL`/`SESSION_SIGNING_KEY`/
     `TEXCENTER_LIVE_USER_ID` from `creds/`, run
     `pnpm exec tsx scripts/probe-live-ws-payload.mjs`. Expect
     `kind: "ok"`, `helloSeen: true`, `fileListSeen: true`. This
     is the first probe that exercises the 1024MB runtime floor.
  2. Provision the test OAuth client (operator step — needs human
     in GCP console), push `TEST_OAUTH_BYPASS_KEY` via `flyctl
     secrets set`, export `TEXCENTER_FULL_PIPELINE=1`, wire the
     spec into the deploy workflow so no operator-gated tests
     remain. M8.pw.4 then runs green automatically on every deploy.

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
