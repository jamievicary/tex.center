// Unit test for the pure `buildGoogleAuthorizeRedirect` builder.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { generatePkce, verifyStateCookie } from "../../../packages/auth/src/index.ts";
import { buildGoogleAuthorizeRedirect } from "../src/lib/server/oauthStart.ts";

const key = randomBytes(32);
const pkce = generatePkce();
const state = randomBytes(32).toString("base64url");
const now = 1_700_000_000;
const ttl = 600;

const out = buildGoogleAuthorizeRedirect({
  clientId: "TEST_CLIENT.apps.googleusercontent.com",
  redirectUri: "https://tex.center/auth/google/callback",
  signingKey: key,
  pkce,
  state,
  nowSeconds: now,
  stateTtlSeconds: ttl,
  secureCookie: true,
  cookieName: "tc_oauth_state",
});

// --- location URL ------------------------------------------------

const u = new URL(out.location);
assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
assert.equal(u.searchParams.get("client_id"), "TEST_CLIENT.apps.googleusercontent.com");
assert.equal(
  u.searchParams.get("redirect_uri"),
  "https://tex.center/auth/google/callback",
);
assert.equal(u.searchParams.get("response_type"), "code");
assert.equal(u.searchParams.get("scope"), "openid email profile");
assert.equal(u.searchParams.get("code_challenge"), pkce.challenge);
assert.equal(u.searchParams.get("code_challenge_method"), "S256");
assert.equal(u.searchParams.get("state"), state);
assert.equal(u.searchParams.get("prompt"), "select_account");

// PKCE verifier MUST NOT be in the URL.
assert.equal(u.searchParams.has("code_verifier"), false);
assert.equal(out.location.includes(pkce.verifier), false);

// --- cookie ------------------------------------------------------

assert.match(out.stateCookie, /^tc_oauth_state=/u);
const parts = out.stateCookie.split("; ");
const map = new Map();
const [first, ...rest] = parts;
const eq = first.indexOf("=");
map.set(first.slice(0, eq), first.slice(eq + 1));
for (const p of rest) {
  const i = p.indexOf("=");
  if (i === -1) map.set(p, true);
  else map.set(p.slice(0, i), p.slice(i + 1));
}
assert.equal(map.get("Path"), "/auth");
assert.equal(map.get("HttpOnly"), true);
assert.equal(map.get("SameSite"), "Lax");
assert.equal(map.get("Secure"), true);
assert.equal(map.get("Max-Age"), String(ttl));

// Cookie value verifies under the same key, decodes to our payload,
// and exp = now + ttl.
const token = map.get("tc_oauth_state");
const v = verifyStateCookie(token, key, now);
assert.equal(v.ok, true);
if (v.ok) {
  assert.equal(v.payload.state, state);
  assert.equal(v.payload.verifier, pkce.verifier);
  assert.equal(v.payload.exp, now + ttl);
}

// --- secureCookie=false drops Secure -----------------------------

{
  const out2 = buildGoogleAuthorizeRedirect({
    clientId: "X",
    redirectUri: "http://localhost:3000/auth/google/callback",
    signingKey: key,
    pkce,
    state,
    nowSeconds: now,
    stateTtlSeconds: ttl,
    secureCookie: false,
    cookieName: "tc_oauth_state",
  });
  assert.equal(out2.stateCookie.includes("Secure"), false);
}

console.log("apps/web oauthStart builder: all assertions passed");
