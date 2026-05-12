# Deploy verification probes

Run these after any deploy that touches `apps/web` config, secrets,
or routing. They are the "stability is the signal" check for the
live control plane: a green deploy is not the same as a working
deploy (see discussion 76 — iter 73 verified `/healthz` and `/` only
and missed that OAuth was 500-ing because `creds/` is not in the
image).

All probes hit `https://tex.center`. Run from any host with internet
egress.

## Probes

```sh
# 1. Liveness — must be 200 and JSON.
node -e 'fetch("https://tex.center/healthz").then(async r=>{
  if (r.status !== 200) throw new Error("healthz status "+r.status);
  const b = await r.text();
  if (!b.includes("tex-center-web-v1")) throw new Error("healthz body "+b);
  console.log("healthz ok:", b);
})'

# 2. Unauth root — must be 200 HTML (the white sign-in page).
node -e 'fetch("https://tex.center/").then(async r=>{
  if (r.status !== 200) throw new Error("/ status "+r.status);
  console.log("/ ok:", r.status, r.headers.get("content-type"));
})'

# 3. OAuth start — must be 302 to accounts.google.com with the
#    expected client_id and redirect_uri. Catches the discussion-76
#    failure mode (missing GOOGLE_OAUTH_CLIENT_ID/SECRET env vars in
#    production → 500 instead of redirect).
node -e 'fetch("https://tex.center/auth/google/start",{redirect:"manual"}).then(async r=>{
  if (r.status !== 302) {
    const t = await r.text();
    throw new Error("oauth start status "+r.status+" body "+t.slice(0,300));
  }
  const loc = r.headers.get("location") ?? "";
  if (!loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")) {
    throw new Error("oauth start location "+loc);
  }
  const u = new URL(loc);
  if (!u.searchParams.get("client_id")) throw new Error("no client_id");
  if (u.searchParams.get("redirect_uri") !== "https://tex.center/auth/google/callback") {
    throw new Error("redirect_uri "+u.searchParams.get("redirect_uri"));
  }
  console.log("oauth start ok: 302 client_id=", u.searchParams.get("client_id"));
})'

# 4. OAuth callback synthetic — must NOT be 500. The route's
#    `?error=fake` branch should early-return 400 with the state
#    cookie cleared. A 500 here means the callback module graph
#    failed to evaluate (e.g. a runtime dep like `jose` missing
#    from the image — discussion 129's latent-since-day-one bug,
#    invisible to probes 1–3 because nothing else imports `jose`).
node -e 'fetch("https://tex.center/auth/google/callback?error=fake",{redirect:"manual"}).then(async r=>{
  if (r.status === 500) {
    const t = await r.text();
    throw new Error("callback 500 body "+t.slice(0,400));
  }
  if (r.status !== 400) throw new Error("callback status "+r.status);
  console.log("callback synthetic ok: 400 (route reached)");
})'
```

A failing probe is a deploy failure. Do not declare the deploy done
until all four pass.

## Playwright wrapper

The probes above (plus the WS-proxy probes below) are also
encoded as `tests_gold/playwright/verifyLive.spec.ts`, runnable
as a single command from this repo:

```sh
PLAYWRIGHT_SKIP_WEBSERVER=1 \
  pnpm exec playwright test \
    --config tests_gold/playwright.config.ts \
    --project=live --grep "live deploy verification"
```

Or via the gold-test wrapper:

```sh
TEXCENTER_LIVE_TESTS=1 bash tests_gold/run_tests.sh
```

(The wrapper additionally runs the unauth `landing.spec.ts`
against live and the authed specs if `TEXCENTER_LIVE_DB_PASSWORD`
+ `TEXCENTER_LIVE_USER_ID` are set; otherwise those self-skip.)
Treat green Playwright as the deploy-success signal — equivalent
to the manual `node -e` snippets but harder to forget steps from.

## WS proxy probes (after any change to `apps/web/src/server.ts`, `wsProxy.ts`, or `wsAuth.ts`)

The control plane hijacks HTTP Upgrade requests for
`/ws/project/<id>` and proxies them to
`tex-center-sidecar.internal:3001` over Fly 6PN. Other upgrade
paths get `404 Not Found`. Without a valid `tc_session` cookie the
proxy short-circuits to `401 Unauthorized` and does **not** dial
the sidecar.

```sh
node -e '
const http = require("https");
function probe(path) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "tex.center", port: 443, method: "GET", path,
      headers: {
        "Connection": "Upgrade", "Upgrade": "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Host": "tex.center",
      },
    });
    req.on("upgrade", (res, sock) => { sock.destroy(); resolve("upgrade "+res.statusCode); });
    req.on("response", res => resolve("response "+res.statusCode));
    req.on("error", e => resolve("ERR "+e.message));
    req.end();
  });
}
(async () => {
  const a = await probe("/ws/project/smoke");
  const b = await probe("/ws/nope");
  if (a !== "response 401") throw new Error("ws /ws/project/smoke: " + a);
  if (b !== "response 404") throw new Error("ws /ws/nope: " + b);
  console.log("ws proxy ok:", a, "/", b);
})();'
```

Verifying the happy-path (valid cookie → upgrade succeeds, sidecar
machine wakes) requires `DATABASE_URL` on the control plane to be
populated and the bootstrap admin user's session minted via
`tests_gold/lib/src/mintSession.ts`. That probe is deferred to the
M7.1 slice that adds DB wiring to the control plane.

## Manual prerequisite (one-shot, not automatable)

The Google Cloud Console OAuth client must list
`https://tex.center/auth/google/callback` under "Authorized redirect
URIs". The Google Console is not self-serve from the API. If
probe 3 succeeds but a real sign-in attempt at the redirected URL
returns `redirect_uri_mismatch`, this is the cause.

## Secrets the live app expects

Set via `flyctl secrets set --app tex-center` (one rolling restart
applies all of them):

| name                          | source                                    |
| ----------------------------- | ----------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`      | `creds/google-oauth.json` → `.client_id`  |
| `GOOGLE_OAUTH_CLIENT_SECRET`  | `creds/google-oauth.json` → `.client_secret` |
| `GOOGLE_OAUTH_REDIRECT_URI`   | `https://tex.center/auth/google/callback` |
| `SESSION_SIGNING_KEY`         | `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'` |
| `NODE_ENV`                    | `production` (suppresses dev creds-file fallback) |

`DATABASE_URL` is not currently set — the app does not yet require
Postgres on the live control plane (sessions are stateless; project
storage is not yet wired through the live deploy). When M7 wiring
lands, add it here.

### Migration-on-boot (M7.1.3 prep)

When `DATABASE_URL` is set, also set `RUN_MIGRATIONS_ON_BOOT=1` so
the control plane applies pending migrations before serving traffic.
The Dockerfile copies `packages/db/src/migrations/` into
`/app/migrations`, matching `bootMigrations.ts`'s default. Override
with `MIGRATIONS_DIR=<path>` if needed. Without the flag, boot is a
no-op against migrations and ops can apply them out-of-band via
`pnpm --filter @tex-center/db db:migrate` against `flyctl proxy`.
