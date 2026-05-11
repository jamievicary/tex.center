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
```

A failing probe is a deploy failure. Do not declare the deploy done
until all three pass.

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
