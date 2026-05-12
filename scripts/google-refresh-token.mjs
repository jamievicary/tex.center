// One-shot helper: run the Google OAuth Authorization Code + PKCE
// flow with `access_type=offline&prompt=consent`, capture the
// refresh_token, write it to `creds/google-refresh-token.txt`.
//
// Why a separate OAuth client (not creds/google-oauth.json, the
// production client): a refresh token is a long-lived credential
// that bypasses the consent screen. Issuing one against the prod
// client would mean a leaked test token could mint Google sessions
// against the real client_id. The test client is purely a
// developer/CI artefact whose refresh token is scoped to obtaining
// ID tokens for the dev account during deploy-verify probes (M8.pw.3.3).
//
// Usage (one-time per CI environment):
//
//   node scripts/google-refresh-token.mjs \
//       --credentials creds/google-oauth-test.json \
//       [--port 4567] \
//       [--output creds/google-refresh-token.txt] \
//       [--scope "openid email"]
//
// Walks the user through:
//   1. Print authorize URL → user opens in a browser.
//   2. Local HTTP server on `--port` receives the redirect.
//   3. Token-exchange code + verifier at oauth2.googleapis.com/token.
//   4. Write `refresh_token` (chmod 0600) to `--output`.
//
// The test OAuth client must:
//   - be type "Web application",
//   - list `http://localhost:<port>/oauth-callback` as an
//     authorized redirect URI (default port 4567),
//   - have the same Google account (jamievicary@gmail.com) on its
//     OAuth consent screen as an allowed test user.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_PATH = "/oauth-callback";

const { values } = parseArgs({
  options: {
    credentials: { type: "string", default: "creds/google-oauth-test.json" },
    port: { type: "string", default: "4567" },
    output: { type: "string", default: "creds/google-refresh-token.txt" },
    scope: { type: "string", default: "openid email" },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`--port must be a TCP port; got ${values.port}`);
}

const creds = JSON.parse(readFileSync(values.credentials, "utf8"));
if (typeof creds.client_id !== "string" || creds.client_id === "") {
  fail(`${values.credentials} missing client_id`);
}
if (typeof creds.client_secret !== "string" || creds.client_secret === "") {
  fail(`${values.credentials} missing client_secret`);
}

const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`;
const state = b64u(randomBytes(16));
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash("sha256").update(verifier, "utf8").digest());

const authorizeUrl = (() => {
  const p = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: values.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
})();

console.log("Open the following URL in a browser signed in as the");
console.log("test Google account (jamievicary@gmail.com):\n");
console.log(`  ${authorizeUrl}\n`);
console.log(`Listening on ${redirectUri} for the redirect…`);

const { code } = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== REDIRECT_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
      return;
    }
    const returnedState = url.searchParams.get("state") ?? "";
    const returnedCode = url.searchParams.get("code") ?? "";
    const returnedError = url.searchParams.get("error");
    if (returnedError) {
      respond(res, 400, `OAuth error: ${returnedError}`);
      server.close();
      reject(new Error(`OAuth redirect carried error: ${returnedError}`));
      return;
    }
    if (!constantTimeEq(returnedState, state)) {
      respond(res, 400, "state mismatch");
      server.close();
      reject(new Error("state mismatch on OAuth redirect"));
      return;
    }
    if (returnedCode === "") {
      respond(res, 400, "missing code");
      server.close();
      reject(new Error("OAuth redirect missing ?code"));
      return;
    }
    respond(
      res,
      200,
      "Refresh token captured. You may close this tab.",
    );
    server.close();
    resolve({ code: returnedCode });
  });
  server.on("error", reject);
  server.listen(port, "127.0.0.1");
});

const body = new URLSearchParams({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirectUri,
  client_id: creds.client_id,
  client_secret: creds.client_secret,
  code_verifier: verifier,
});
const tokenRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  },
  body: body.toString(),
});
if (!tokenRes.ok) {
  const text = (await tokenRes.text()).slice(0, 512);
  fail(`Google token endpoint ${tokenRes.status}: ${text}`);
}
const tokens = await tokenRes.json();
if (typeof tokens.refresh_token !== "string" || tokens.refresh_token === "") {
  fail(
    "Google did not return a refresh_token. Make sure the OAuth client " +
      "has not previously been consented for this account without " +
      "prompt=consent (revoke at https://myaccount.google.com/permissions " +
      "and retry).",
  );
}

writeFileSync(values.output, tokens.refresh_token + "\n", { mode: 0o600 });
chmodSync(values.output, 0o600);
console.log(`Wrote refresh_token → ${values.output}`);

function respond(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(text + "\n");
}

function constantTimeEq(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function b64u(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function fail(msg) {
  console.error(`google-refresh-token: ${msg}`);
  process.exit(2);
}
