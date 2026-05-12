// Unit test for `finalizeGoogleSession`, the post-token-verify orchestrator
// factored out of `resolveGoogleCallback` for M8.pw.3. A future test-only
// route will call it directly with a verified ID token's claims, bypassing
// the PKCE/code-exchange leg.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  isAllowedEmail,
  verifySessionToken,
} from "../../../packages/auth/src/index.ts";
import { finalizeGoogleSession } from "../src/lib/server/oauthCallback.ts";

const KEY = randomBytes(32);
const NOW = 1_700_000_000;
const SESSION_TTL = 60 * 60 * 24 * 30;

function baseInput(overrides = {}) {
  return {
    claims: {
      sub: "1234567890",
      email: "jamievicary@gmail.com",
      emailVerified: true,
      name: "Jamie",
    },
    signingKey: KEY,
    isEmailAllowed: isAllowedEmail,
    nowSeconds: NOW,
    sessionTtlSeconds: SESSION_TTL,
    secureCookie: true,
    sessionCookieName: "tc_session",
    successPath: "/projects",
    signedOutPath: "/",
    createSession: async (claims) => {
      assert.equal(claims.sub, "1234567890");
      return "sid-uuid-x";
    },
    ...overrides,
  };
}

function getCookieValue(cookie, name) {
  const first = cookie.split("; ")[0];
  const eq = first.indexOf("=");
  assert.equal(first.slice(0, eq), name);
  return first.slice(eq + 1);
}

// Happy path: allowed user → 302 success + signed session cookie.
{
  const r = await finalizeGoogleSession(baseInput());
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/projects");
  assert.equal(r.setCookies.length, 1);
  const token = getCookieValue(r.setCookies[0], "tc_session");
  const v = verifySessionToken(token, KEY, NOW);
  assert.ok(v.ok, `session token invalid: ${JSON.stringify(v)}`);
  assert.equal(v.payload.sid, "sid-uuid-x");
  assert.equal(v.payload.exp, NOW + SESSION_TTL);
}

// Prior set-cookies (e.g. a state-cookie clear) are preserved in order.
{
  const r = await finalizeGoogleSession(
    baseInput({
      priorSetCookies: ["tc_oauth_state=; Path=/auth; Max-Age=0"],
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.setCookies.length, 2);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state="));
  assert.ok(r.setCookies[1].startsWith("tc_session="));
}

// Allowlist deny: 302 to signed-out path; no session cookie.
{
  const r = await finalizeGoogleSession(
    baseInput({
      claims: {
        sub: "999",
        email: "stranger@example.com",
        emailVerified: true,
        name: null,
      },
      priorSetCookies: ["tc_oauth_state=; Path=/auth; Max-Age=0"],
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/");
  assert.equal(r.setCookies.length, 1);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state="));
}

// email_verified=false: also denied even when the email is allowlisted.
{
  const r = await finalizeGoogleSession(
    baseInput({
      claims: {
        sub: "1234567890",
        email: "jamievicary@gmail.com",
        emailVerified: false,
        name: null,
      },
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/");
}

// createSession throws → 500 error result with prior cookies preserved.
{
  const r = await finalizeGoogleSession(
    baseInput({
      priorSetCookies: ["tc_oauth_state=; Path=/auth; Max-Age=0"],
      createSession: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 500);
  assert.match(r.body, /Session persistence failed: db down/);
  assert.equal(r.setCookies.length, 1);
  assert.ok(r.setCookies[0].startsWith("tc_oauth_state="));
}

// secureCookie=false (local http dev) omits the Secure attribute.
{
  const r = await finalizeGoogleSession(baseInput({ secureCookie: false }));
  assert.equal(r.kind, "redirect");
  const cookie = r.setCookies[0];
  assert.ok(!cookie.split("; ").includes("Secure"), cookie);
}

console.log("finalizeGoogleSession tests passed");
