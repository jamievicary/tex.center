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

---

# Live deploy state — sidecar (M7.0.2)

First deploy of `tex-center-sidecar` ran 2026-05-11 21:22 UTC and was
verified end-to-end at iteration 93.

## Fly app

- **App:** `tex-center-sidecar` (org `personal`)
- **Region:** `fra`
- **Topology:** 6PN-only, no public IPs. Reachable only at
  `tex-center-sidecar.internal:3001`.
- **Image:** `tex-center-sidecar:deployment-01KRCEJJHCD0FZWFBWNM9KM5PC`
  (sha256 `f31ef7bed0805cd999c188eb7fff542f06b1043e8add7fbbf6d7cb592a683853`)
- **Machines:**
  - `d895e7ea479958` (primary)
  - `683437eb1e3378` (standby)

## Canonical deploy command

```sh
flyctl deploy --remote-only --no-public-ips \
  -a tex-center-sidecar --config apps/sidecar/fly.toml .
```

Always pass both `-a` and `--config` — omitting them redeploys the
control plane (iter 87 misfire). Run from the repo root.

## Verification

End-to-end probe via `flyctl ssh console -a tex-center-sidecar
--machine d895e7ea479958` confirmed at iter 93 close:

- `/opt/engine/bin/lualatex-incremental --version` →
  `LuaTeX, Version 1.25.9 (TeX Live 2027/dev)`
- `/opt/engine/web2c/lualatex.fmt` present (baked at image build)
- Trivial `\documentclass{article}…` compiles to a valid 1-page PDF
- Sidecar Fastify server listens on `127.0.0.1:3001` and on the
  6PN address `[fdaa:74:ac9b:a7b:831:bdfe:8dc2:2]:3001`
- TEXMFCNF env in image:
  `/etc/texmf/web2c:/usr/share/texlive/texmf-dist/web2c` (iter 88 fix)

## Notes

- No auto-stop is configured at the fly.toml layer; per-project
  idle stop is M7.3 on per-project Machines, not the shared sidecar.
- The trial-stop seen at 21:28 on the original 21:22 boot was
  resolved by switching the org to a paid card (discussion 89).
