// Unit test for the pure `resolveGoogleCallback` orchestrator.
//
// Every branch of the discriminated union is exercised with
// stubbed I/O — no network, no SvelteKit, no real Google.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  generatePkce,
  isAllowedEmail,
  signStateCookie,
  verifySessionToken,
} from "../../../packages/auth/src/index.ts";
import { resolveGoogleCallback } from "../src/lib/server/oauthCallback.ts";

const KEY = randomBytes(32);
const CLIENT_ID = "TEST_CLIENT.apps.googleusercontent.com";
const NOW = 1_700_000_000;
const SESSION_TTL = 60 * 60 * 24 * 30;

function baseInput(overrides = {}) {
  const pkce = generatePkce();
  const state = "abc123_-XYZ";
  const stateCookie = signStateCookie(
    { state, verifier: pkce.verifier, exp: NOW + 600 },
    KEY,
  );
  return {
    stateCookieValue: stateCookie,
    queryState: state,
    queryCode: "GOOGLE_AUTH_CODE",
    queryError: null,
    clientId: CLIENT_ID,
    signingKey: KEY,
    isEmailAllowed: isAllowedEmail,
    nowSeconds: NOW,
    sessionTtlSeconds: SESSION_TTL,
    secureCookie: true,
    stateCookieName: "tc_oauth_state",
    sessionCookieName: "tc_session",
    successPath: "/editor",
    signedOutPath: "/",
    createSession: async (claims) => {
      assert.equal(claims.sub, "1234567890");
      assert.equal(claims.email, "jamievicary@gmail.com");
      return "fixed-sid-uuid";
    },
    exchangeCode: async ({ code, verifier }) => {
      assert.equal(code, "GOOGLE_AUTH_CODE");
      assert.equal(verifier, pkce.verifier);
      return { idToken: "id.token.xyz" };
    },
    verifyIdToken: async ({ idToken, audience }) => {
      assert.equal(idToken, "id.token.xyz");
      assert.equal(audience, CLIENT_ID);
      return {
        sub: "1234567890",
        email: "jamievicary@gmail.com",
        emailVerified: true,
        name: "Jamie",
      };
    },
    ...overrides,
  };
}

function assertCookieAttr(cookie, key, expected) {
  const parts = cookie.split("; ");
  if (expected === true) {
    assert.ok(parts.includes(key), `expected attribute ${key} in ${cookie}`);
    return;
  }
  const found = parts.find((p) => p.startsWith(`${key}=`));
  assert.ok(found, `attribute ${key}= not in ${cookie}`);
  assert.equal(found.slice(key.length + 1), expected);
}

function getCookieValue(cookie, name) {
  const first = cookie.split("; ")[0];
  const eq = first.indexOf("=");
  assert.equal(first.slice(0, eq), name);
  return first.slice(eq + 1);
}

// --- Happy path: allowed user --------------------------------------

{
  const r = await resolveGoogleCallback(baseInput());
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/editor");
  assert.equal(r.setCookies.length, 2);

  // First cookie: clear-state.
  assertCookieAttr(r.setCookies[0], "Path", "/auth");
  assertCookieAttr(r.setCookies[0], "Max-Age", "0");
  assertCookieAttr(r.setCookies[0], "HttpOnly", true);
  assertCookieAttr(r.setCookies[0], "Secure", true);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state=;"));

  // Second cookie: session.
  assertCookieAttr(r.setCookies[1], "Path", "/");
  assertCookieAttr(r.setCookies[1], "Max-Age", String(SESSION_TTL));
  assertCookieAttr(r.setCookies[1], "HttpOnly", true);
  assertCookieAttr(r.setCookies[1], "SameSite", "Lax");
  assertCookieAttr(r.setCookies[1], "Secure", true);

  const token = getCookieValue(r.setCookies[1], "tc_session");
  const v = verifySessionToken(token, KEY, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.payload.sid, "fixed-sid-uuid");
  assert.equal(v.payload.exp, NOW + SESSION_TTL);
}

// --- secureCookie=false drops Secure on both cookies ---------------

{
  const r = await resolveGoogleCallback(baseInput({ secureCookie: false }));
  assert.equal(r.kind, "redirect");
  for (const c of r.setCookies) {
    assert.equal(c.includes("Secure"), false);
  }
}

// --- Disallowed email → 302 to / + clear state cookie --------------

{
  const r = await resolveGoogleCallback(
    baseInput({
      verifyIdToken: async () => ({
        sub: "9999",
        email: "stranger@example.com",
        emailVerified: true,
        name: null,
      }),
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/");
  assert.equal(r.setCookies.length, 1);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state=;"));
}

// --- email_verified=false → signed out -----------------------------

{
  const r = await resolveGoogleCallback(
    baseInput({
      verifyIdToken: async () => ({
        sub: "9999",
        email: "jamievicary@gmail.com",
        emailVerified: false,
        name: null,
      }),
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/");
}

// --- Missing state cookie → 400 ------------------------------------

{
  const r = await resolveGoogleCallback(baseInput({ stateCookieValue: null }));
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /state cookie/i);
  assert.equal(r.setCookies.length, 1);
}

// --- Missing query state → 400 -------------------------------------

{
  const r = await resolveGoogleCallback(baseInput({ queryState: null }));
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /state/i);
}

// --- Missing code → 400 --------------------------------------------

{
  const r = await resolveGoogleCallback(baseInput({ queryCode: null }));
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /code/i);
}

// --- Malformed query state → 400 -----------------------------------

{
  const r = await resolveGoogleCallback(baseInput({ queryState: "bad state!" }));
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /malformed/i);
}

// --- Google ?error= → 400 with the code echoed ---------------------

{
  const r = await resolveGoogleCallback(
    baseInput({ queryError: "access_denied" }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /access_denied/);
}

// --- Google ?error= with weird chars → "unknown" -------------------

{
  const r = await resolveGoogleCallback(
    baseInput({ queryError: "<script>alert(1)</script>" }),
  );
  assert.equal(r.kind, "error");
  assert.match(r.body, /unknown/);
  assert.equal(r.body.includes("<"), false);
}

// --- Bad signature on state cookie ---------------------------------

{
  const other = randomBytes(32);
  const stolen = signStateCookie(
    { state: "x", verifier: generatePkce().verifier, exp: NOW + 600 },
    other,
  );
  const r = await resolveGoogleCallback(
    baseInput({ stateCookieValue: stolen, queryState: "x" }),
  );
  assert.equal(r.kind, "error");
  assert.match(r.body, /signature/i);
}

// --- Expired state cookie ------------------------------------------

{
  const pkce = generatePkce();
  const expired = signStateCookie(
    { state: "x", verifier: pkce.verifier, exp: NOW - 1 },
    KEY,
  );
  const r = await resolveGoogleCallback(
    baseInput({ stateCookieValue: expired, queryState: "x" }),
  );
  assert.equal(r.kind, "error");
  assert.match(r.body, /expired/i);
}

// --- State mismatch (cookie state != query state) ------------------

{
  const pkce = generatePkce();
  const cookie = signStateCookie(
    { state: "cookie_state", verifier: pkce.verifier, exp: NOW + 600 },
    KEY,
  );
  const r = await resolveGoogleCallback(
    baseInput({ stateCookieValue: cookie, queryState: "query_state" }),
  );
  assert.equal(r.kind, "error");
  assert.match(r.body, /mismatch/i);
}

// --- Token exchange throws → 502 -----------------------------------

{
  const r = await resolveGoogleCallback(
    baseInput({
      exchangeCode: async () => {
        throw new Error("network blew up");
      },
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 502);
  assert.match(r.body, /network blew up/);
}

// --- ID-token verify throws → 401 ----------------------------------

{
  const r = await resolveGoogleCallback(
    baseInput({
      verifyIdToken: async () => {
        throw new Error("signature is bad");
      },
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /signature is bad/);
}

// --- createSession throws → 500 ------------------------------------

{
  const r = await resolveGoogleCallback(
    baseInput({
      createSession: async () => {
        throw new Error("db is down");
      },
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 500);
  assert.match(r.body, /db is down/);
  // State cookie still cleared on this terminal branch.
  assert.equal(r.setCookies.length, 1);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state=;"));
}

console.log("apps/web oauthCallback resolver: all assertions passed");
