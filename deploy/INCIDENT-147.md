# INCIDENT-147 — live WS proxy returns 502 on authed upgrade

**Status:** Root cause identified, fix not yet landed.
**Diagnosed:** 2026-05-12 (iter 147).
**Affects:** every authed WebSocket from `apps/web` to its sidecar
on the live deploy — i.e. typing-saves, create-file, PDF preview.

## Symptom

Browser opens `wss://tex.center/ws/project/<id>` after sign-in;
the connection never reaches the sidecar. From the browser the WS
appears to disconnect immediately.

Probe (`scripts/probe-live-ws.mjs`, run iter 147 with valid
session cookie + real `projects.id` owned by the live user):

```
RESULT: response 502 in 243 ms
  via: 1.1 fly.io                # one hop, NOT two
  content-length: 0
  body: <empty>
```

Compare:
- anon `/ws/project/smoke` → `response 401` (2 via hops; our app
  replied cleanly).
- authed `/ws/project/00000000-…` (valid cookie, project not
  owned) → `response 403` (2 via hops; our app replied cleanly).
- authed `/ws/project/<owned-id>` → `response 502` (1 via hop;
  Fly's edge synthesised the 502 because our control-plane closed
  the upstream connection without writing any response).

The `tex-center` control-plane proxy log shows, for each failing
probe:

```
error.message="could not complete HTTP request to instance:
  hyper error: connection closed before message completed"
request.url="/ws/project/<id>"
```

i.e. Fly's edge received an HTTP/1.1 request, expected either a
normal response or a 101 upgrade, and got a closed socket.

## Root cause

The per-project sidecar Fly Machines are running, but they are
binding only to `127.0.0.1` (plus the Docker bridge IPv4
addresses), not to Fly's 6PN IPv6 address.

Evidence — sidecar machine `e82227ef555508` startup logs
(2026-05-12T09:03:18Z):

```
Server listening at http://127.0.0.1:3001
Server listening at http://172.19.47.98:3001
Server listening at http://172.19.47.99:3001
```

No `Server listening at http://[fdaa:74:ac9b:…]:3001` line. The
control plane dials `<machine-id>.vm.tex-center-sidecar.internal:3001`
which resolves to `fdaa:74:ac9b:a7b:3fb:cf66:ab54:2` (6PN IPv6).
The sidecar is not listening on that address; the TCP connect is
refused immediately, hence the 243 ms timing.

Code site: `apps/sidecar/src/index.ts:19`

```ts
const host = process.env.HOST ?? "127.0.0.1";
```

There is no `HOST` env in the per-project Machine config (see
`MachineConfig` constructed in
`apps/web/src/lib/server/upstreamFromEnv.ts`; only the SHA-pinned
`SIDECAR_IMAGE` is passed, no env block), and the sidecar Fly
app's deployed config does not set `HOST` for Machines created
on the fly.

State across the live stack at probe time:

- `machine_assignments` rows for both live projects have
  `state='running'` and `last_seen_at` recent.
- `flyctl machines list -a tex-center-sidecar` shows the two
  per-project Machines as `started`.
- `flyctl ssh console -a tex-center -C "printenv SIDECAR_IMAGE"`
  returns the sha-pinned digest exactly. Image config is fine.

## Secondary bug (not root cause; cosmetic for ops)

`apps/web/src/lib/server/wsProxy.ts:321-327`: when the upstream
TCP connection errors (e.g. `ECONNREFUSED`), the cleanup path
calls `clientSocket.destroy()` without first writing
`HTTP/1.1 502 Bad Gateway\r\n…`. That's why Fly's edge has to
synthesise its own 502 (visible by the single `via: 1.1 fly.io`
hop). With a written 502 in place we would see two `via` hops
and the proxy log would surface the dial error in our own logs.

Fix scope: write a 502 status line on the `upstream-error` path
before destroying the socket, symmetric with the `resolve-error`
path at lines 192-198 which already does this. Useful but not
load-bearing for the user-visible bug — root-cause fix is the
sidecar binding.

## Fix plan (iter 148+)

1. **Make sidecar bind to all interfaces.** Two options, in
   order of preference:
   - `apps/sidecar/src/index.ts`: change default from
     `"127.0.0.1"` to `"::"` (binds IPv4 + IPv6 dual-stack on
     Node). Keep the `HOST` env override for test rigs that want
     to localhost-pin.
   - Or set `HOST=::` in the per-project `MachineConfig.env` in
     `apps/web/src/lib/server/upstreamFromEnv.ts`.
   The first option is preferred: it doesn't depend on the
   control plane passing the right env every time, and the local
   dev story is unchanged because dev rigs don't go through Fly
   6PN.
2. **Redeploy sidecar.** The fix is in the sidecar image, so the
   control plane's `SIDECAR_IMAGE` secret must roll to the new
   sha. `flyctl deploy -a tex-center-sidecar` builds + pushes the
   image; the new sha shows in `flyctl image show -a
   tex-center-sidecar`; then `flyctl secrets set
   SIDECAR_IMAGE=registry.fly.io/tex-center-sidecar@sha256:<new>
   -a tex-center` rolls the control plane.
3. **Destroy the stale Machines.** The two per-project Machines
   created with the old image (`e82227ef555508`,
   `784e907b637638`) will keep using the old image until
   destroyed. `flyctl machines destroy --force` them; the next
   WS upgrade re-creates them at the new sha via
   `upstreamResolver.ensureMachineId`.
4. **Re-run `scripts/probe-live-ws.mjs`** with a generous timeout
   (≥ 90 s — cold-start of a fresh per-project Machine plus the
   first Yjs handshake can be slow). Expect `result.kind ===
   "upgrade"` with `status === 101`.
5. **Write a regression test.** A `tests_normal/` (or unit-level)
   case that asserts `apps/sidecar/src/index.ts`'s default host
   is `"::"` (not `"127.0.0.1"`) — small, deterministic, exists
   to prevent re-regression.
6. **Also land the wsProxy 502 fix** so future dial failures
   surface in our own proxy logs, not as opaque Fly-edge 502s.
7. **Activate M8.pw.4** (`verifyLiveFullPipeline.spec.ts`) as
   a hard deploy gate per PLAN.md CRITICAL PATH.

## Reproduction

Required env (run from a host with internet egress):

```sh
# in shell A
FLY_API_TOKEN=$(cat creds/fly.token) \
  flyctl proxy 5435:5432 -a tex-center-db

# in shell B
SIGNING_KEY=$(grep -oE '[A-Za-z0-9_-]{40,}' \
  creds/session-signing-key.txt | head -1)
USER_ID=$(grep -oE \
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  creds/live-user-id.txt | head -1)
PATH="$PWD/.tools/node/bin:$PATH" \
  DATABASE_URL="postgres://postgres:BiJDuSdqaogt9lM@127.0.0.1:5435/tex_center?sslmode=disable" \
  SESSION_SIGNING_KEY="$SIGNING_KEY" \
  TEXCENTER_LIVE_USER_ID="$USER_ID" \
  pnpm exec tsx scripts/probe-live-ws.mjs
```

The probe reuses an existing owned project (or creates one), mints
a 5-minute session, runs the upgrade against the real host, and
runs a second upgrade against a bogus uuid to confirm the cookie
itself is valid. The session is deleted on exit; created project
(if any) is intentionally left in place so retries reuse it.
