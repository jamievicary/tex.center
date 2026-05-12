#!/usr/bin/env bash
# Build the apps/web runtime image and probe every server endpoint
# for module-load failures. Catches the iter-129 incident class:
# adapter-node's Rollup pass leaves npm deps as bare specifiers, so a
# missing `node_modules` in the runtime stage surfaces only as a
# `Cannot find package '<name>'` / `ERR_MODULE_NOT_FOUND` when the
# offending route is first hit.
#
# Runs in CI before `flyctl deploy`. Local: `bash
# scripts/smoke-runtime-image.sh`. Requires `docker` + `curl`.
#
# DATABASE_URL is intentionally unset: `runBootMigrations` short-
# circuits on no URL, and none of the probed GET endpoints touch the
# DB without an authenticated session (see PLAN M8.smoke.0 open
# question). OAuth + session env vars are placeholders so module
# graphs that touch `oauthConfig` / `sessionConfig` load cleanly.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-tex-center-web-smoke:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-tex-center-web-smoke}"
HOST_PORT="${HOST_PORT:-13000}"
BOOT_TIMEOUT_SECS="${BOOT_TIMEOUT_SECS:-60}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  local rc=$?
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    log "container logs (tail 200):"
    docker logs --tail 200 "$CONTAINER_NAME" >&2 || true
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

log "building image $IMAGE_TAG"
docker build -f apps/web/Dockerfile -t "$IMAGE_TAG" .

# 32 random bytes, base64url-encoded. Placeholder only — never used to
# verify a real session in this run.
SESSION_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

log "starting container $CONTAINER_NAME on :$HOST_PORT"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --rm \
  --name "$CONTAINER_NAME" \
  -p "$HOST_PORT:3000" \
  -e SESSION_SIGNING_KEY="$SESSION_KEY" \
  -e GOOGLE_OAUTH_CLIENT_ID="smoke-placeholder.apps.googleusercontent.com" \
  -e GOOGLE_OAUTH_CLIENT_SECRET="smoke-placeholder-secret" \
  -e GOOGLE_OAUTH_REDIRECT_URI="http://localhost:13000/auth/google/callback" \
  -e NODE_ENV=production \
  "$IMAGE_TAG" >/dev/null

BASE_URL="http://127.0.0.1:$HOST_PORT"

log "waiting up to ${BOOT_TIMEOUT_SECS}s for $BASE_URL/healthz"
deadline=$(( $(date +%s) + BOOT_TIMEOUT_SECS ))
while :; do
  if curl -fsS -o /dev/null -m 2 "$BASE_URL/healthz"; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "boot timeout: /healthz never responded with 2xx"
    exit 1
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    log "container exited before /healthz became reachable"
    exit 1
  fi
  sleep 1
done

# Each probe: METHOD PATH. Body is captured and scanned for
# module-resolution failure strings; failure here is the entire point
# of this script. Status codes are reported but only 5xx is a hard
# failure (4xx like 400/401/302 are legitimate for these endpoints
# under the placeholder env).
probes=(
  "GET /"
  "GET /healthz"
  "GET /readyz"
  "GET /auth/google/start"
  "GET /auth/google/callback?error=fake"
  "POST /auth/logout"
  "GET /projects"
  "GET /editor/abc123"
)

fail_count=0
for probe in "${probes[@]}"; do
  method="${probe%% *}"
  path="${probe#* }"
  body_file="$(mktemp)"
  status="$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X "$method" -m 10 \
    -H 'Accept: text/html,application/json' \
    "$BASE_URL$path" || echo "000")"
  body="$(cat "$body_file")"
  rm -f "$body_file"

  bad=""
  if grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module' <<<"$body"; then
    bad="module-not-found in body"
  elif [ "$status" = "000" ]; then
    bad="no response"
  elif [[ "$status" =~ ^5 ]]; then
    # 500s from oauthConfig.ts misconfig errors print a "Server
    # misconfigured" text body, which is fine here — but the body
    # check above is what discriminates. Any other 5xx is a fail.
    if ! grep -q 'Server misconfigured' <<<"$body"; then
      bad="status $status"
    fi
  fi

  if [ -n "$bad" ]; then
    log "FAIL $method $path -> $status ($bad)"
    log "  body (first 400 bytes): ${body:0:400}"
    fail_count=$(( fail_count + 1 ))
  else
    log "OK   $method $path -> $status"
  fi
done

if [ "$fail_count" -gt 0 ]; then
  log "$fail_count probe(s) failed"
  exit 1
fi
log "all ${#probes[@]} probes passed"
