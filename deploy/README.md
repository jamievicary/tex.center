# Live deploy state — control plane

Captured at iteration 73 when M6.3.1 ran for the first time
(2026-05-11). All commands run with creds from `creds/` (gitignored).

## Fly app

- **App:** `tex-center` (org `personal` / "Jamie Vicary", trial plan)
- **Region:** `fra`
- **Primary VM size:** `shared-cpu-1x` / 512 MB (per `fly.toml`)
- **Image:** built by Fly remote builder from `apps/web/Dockerfile`

### IPs

- **IPv6 (dedicated):** `2a09:8280:1::114:4adc:0`
- **IPv4 (shared):** `66.241.125.118` — dedicated v4 allocation is
  disabled on trial orgs ("This functionality is disabled for trial
  organizations. Please add a credit card."). SNI on Fly's shared v4
  routes correctly for custom domains, so the apex `A` record points
  at the shared address. Upgrade to a paid org + `flyctl ips
  allocate-v4 --yes` if/when dedicated v4 becomes required.

## DNS (Cloudflare zone `tex.center`)

Managed by `scripts/cloudflare-dns.mjs`. The script's `--token-file`
expects a raw token; `creds/cloudflare.token` is a JSON object
(`{ token, zone_id, zone }`), so extract `.token` first:

```sh
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("creds/cloudflare.token","utf8")).token)' \
  > /tmp/cf-token
node scripts/cloudflare-dns.mjs \
  --zone tex.center \
  --ipv4 66.241.125.118 \
  --ipv6 2a09:8280:1::114:4adc:0 \
  --token-file /tmp/cf-token
rm /tmp/cf-token
```

Records currently managed at the apex:

| type | name         | content                  | proxied |
| ---- | ------------ | ------------------------ | ------- |
| A    | `tex.center` | `66.241.125.118`         | false   |
| AAAA | `tex.center` | `2a09:8280:1::114:4adc:0`| false   |

No `_acme-challenge` record is needed: Fly's ACME flow falls back to
TLS-ALPN-01 once the apex points at the app, and the cert was issued
~20s after the DNS records went live.

## TLS

- **Hostname:** `tex.center`
- **CA:** Let's Encrypt (RSA + ECDSA dual chain)
- **Issued via:** `flyctl certs create tex.center --app tex-center`

## CI/CD

- **GitHub Actions secret:** `FLY_API_TOKEN` set on
  `github.com/jamievicary/tex.center` (value = contents of
  `creds/fly.token`).
- **Workflow:** `.github/workflows/deploy.yml` — `flyctl deploy
  --remote-only` on push to `main`.

## Verification

```sh
curl -s https://tex.center/healthz     # → {"ok":true,"protocol":"tex-center-web-v1"}
curl -s https://tex.center/ | head -1  # → <!doctype html>
```

Both probes verified on 2026-05-11 at iteration 73 close.
