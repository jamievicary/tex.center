// Unit test for `resolveTestCallback` (M8.pw.3.1) — the pure
// orchestrator behind `POST /auth/google/test-callback`. Drives the
// HMAC-bypass gate + JSON-body shape + ID-token verify hand-off and
// delegates the finalisation to a stub.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

import { resolveTestCallback } from "../src/lib/server/testOauthCallback.ts";

const KEY = randomBytes(32);
const AUDIENCE = "test-client-id";

function sign(bodyText, key = KEY) {
  return createHmac("sha256", key).update(bodyText, "utf8").digest("hex");
}

function baseInput(overrides = {}) {
  const bodyText = JSON.stringify({ idToken: "tok-abc" });
  return {
    bodyText,
    bypassHeader: sign(bodyText),
    bypassKey: KEY,
    audience: AUDIENCE,
    verifyIdToken: async ({ idToken, audience }) => {
      assert.equal(idToken, "tok-abc");
      assert.equal(audience, AUDIENCE);
      return {
        sub: "1234567890",
        email: "jamievicary@gmail.com",
        emailVerified: true,
        name: "Jamie",
      };
    },
    finalize: async (claims) => {
      return {
        kind: "redirect",
        location: "/projects",
        setCookies: [`tc_session=signed-cookie-for-${claims.sub}`],
      };
    },
    ...overrides,
  };
}

// Happy path: valid HMAC + parseable body + verified ID token →
// orchestrator returns whatever finalize produced.
{
  let finalized = false;
  const r = await resolveTestCallback(
    baseInput({
      finalize: async (claims) => {
        finalized = true;
        assert.equal(claims.email, "jamievicary@gmail.com");
        return {
          kind: "redirect",
          location: "/projects",
          setCookies: ["tc_session=xyz"],
        };
      },
    }),
  );
  assert.ok(finalized);
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/projects");
  assert.deepEqual([...r.setCookies], ["tc_session=xyz"]);
}

// Missing X-Test-Bypass header → 401, finalize/verify not called.
{
  let touched = false;
  const r = await resolveTestCallback(
    baseInput({
      bypassHeader: null,
      verifyIdToken: async () => {
        touched = true;
        throw new Error("must not run");
      },
      finalize: async () => {
        touched = true;
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(touched, false);
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /Missing X-Test-Bypass/);
}

// Malformed hex header → 401.
{
  const r = await resolveTestCallback(
    baseInput({ bypassHeader: "not-hex!!" }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /Malformed/);
}

// Right shape, wrong key → 401 (timing-safe path).
{
  const bodyText = JSON.stringify({ idToken: "tok-abc" });
  const r = await resolveTestCallback(
    baseInput({
      bodyText,
      bypassHeader: sign(bodyText, randomBytes(32)),
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /Invalid X-Test-Bypass/);
}

// Right key, wrong body bytes → 401 (signature was over different bytes).
{
  const r = await resolveTestCallback(
    baseInput({
      bodyText: JSON.stringify({ idToken: "different" }),
      bypassHeader: sign(JSON.stringify({ idToken: "tok-abc" })),
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /Invalid X-Test-Bypass/);
}

// Empty bypass key (defensive) → 500 even with otherwise valid input.
{
  const bodyText = JSON.stringify({ idToken: "tok-abc" });
  const r = await resolveTestCallback(
    baseInput({
      bodyText,
      bypassKey: new Uint8Array(0),
      bypassHeader: sign(bodyText),
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 500);
  assert.match(r.body, /empty/);
}

// Body not JSON → 400, signature still required and passes first.
{
  const bodyText = "not-json";
  const r = await resolveTestCallback(
    baseInput({ bodyText, bypassHeader: sign(bodyText) }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /not valid JSON/);
}

// Body JSON but missing idToken → 400.
{
  const bodyText = JSON.stringify({ foo: "bar" });
  const r = await resolveTestCallback(
    baseInput({ bodyText, bypassHeader: sign(bodyText) }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.match(r.body, /idToken/);
}

// Body JSON with idToken="" → 400.
{
  const bodyText = JSON.stringify({ idToken: "" });
  const r = await resolveTestCallback(
    baseInput({ bodyText, bypassHeader: sign(bodyText) }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
}

// verifyIdToken throws → 401 with the error message echoed.
{
  const r = await resolveTestCallback(
    baseInput({
      verifyIdToken: async () => {
        throw new Error("signature check failed");
      },
      finalize: async () => {
        throw new Error("finalize must not run after verify failure");
      },
    }),
  );
  assert.equal(r.kind, "error");
  assert.equal(r.status, 401);
  assert.match(r.body, /signature check failed/);
}

// finalize's result is passed through verbatim (e.g. allowlist deny).
{
  const r = await resolveTestCallback(
    baseInput({
      finalize: async () => ({
        kind: "redirect",
        location: "/",
        setCookies: [],
      }),
    }),
  );
  assert.equal(r.kind, "redirect");
  assert.equal(r.location, "/");
  assert.equal(r.setCookies.length, 0);
}

console.log("testOauthCallback tests passed");
