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
- **Iter 148 — Fix the broken layer.** Change sidecar default
  host to `"::"` (dual-stack IPv6) in `apps/sidecar/src/index.ts`,
  add a regression test asserting that default, deploy the new
  sidecar image, roll `SIDECAR_IMAGE` on `tex-center`, destroy
  the two stale per-project Machines so the next upgrade
  re-creates them at the new sha, re-run the probe and expect
  `kind: "upgrade", status: 101`. Also land the wsProxy 502-on-
  dial-error fix (`apps/web/src/lib/server/wsProxy.ts`
  `upstream.on("error")` path: write `HTTP/1.1 502` before
  `clientSocket.destroy()`) so future dial failures show up as
  our 502 with two via hops rather than Fly's synthetic one.
- **Iter 149 — Activate M8.pw.4 as a hard deploy gate.** Provision
  the test OAuth client (operator step — needs human in GCP
  console), export `TEXCENTER_FULL_PIPELINE=1`, wire the spec into
  the deploy workflow so no operator-gated tests remain.

After iter 149 passes green automatically, the freezes above may
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
