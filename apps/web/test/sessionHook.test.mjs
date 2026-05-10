// Unit test for `resolveSessionHook`. Every branch of the
// discriminated `reason` union is exercised with stubbed I/O.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { signSessionToken } from "../../../packages/auth/src/index.ts";
import { resolveSessionHook } from "../src/lib/server/sessionHook.ts";

const KEY = randomBytes(32);
const NOW = 1_700_000_000;
const COOKIE_NAME = "tc_session";

function baseInput(overrides = {}) {
  return {
    cookieHeader: null,
    sessionCookieName: COOKIE_NAME,
    signingKey: KEY,
    nowSeconds: NOW,
    secureCookie: true,
    lookupSession: async () => {
      throw new Error("lookupSession should not be called in this branch");
    },
    ...overrides,
  };
}

function cookieFor(token) {
  return `othercookie=foo; ${COOKIE_NAME}=${token}; trailing=bar`;
}

// --- no cookie -----------------------------------------------------

{
  const r = await resolveSessionHook(baseInput());
  assert.equal(r.session, null);
  assert.equal(r.clearCookie, null);
  assert.equal(r.reason, "no-cookie");
}

// --- malformed token → bad-token, cookie cleared ------------------

{
  const r = await resolveSessionHook(
    baseInput({ cookieHeader: `${COOKIE_NAME}=not-a-valid-token` }),
  );
  assert.equal(r.session, null);
  assert.equal(r.reason, "bad-token");
  assert.ok(r.clearCookie);
  assert.ok(r.clearCookie.startsWith(`${COOKIE_NAME}=;`));
  assert.ok(r.clearCookie.includes("Max-Age=0"));
  assert.ok(r.clearCookie.includes("Secure"));
}

// --- bad signature → bad-token ------------------------------------

{
  const otherKey = randomBytes(32);
  const sid = randomUUID();
  const token = signSessionToken(
    { sid, exp: NOW + 3600 },
    otherKey,
  );
  const r = await resolveSessionHook(
    baseInput({ cookieHeader: cookieFor(token) }),
  );
  assert.equal(r.reason, "bad-token");
  assert.equal(r.session, null);
  assert.ok(r.clearCookie);
}

// --- expired token → expired-token --------------------------------

{
  const token = signSessionToken(
    { sid: randomUUID(), exp: NOW - 1 },
    KEY,
  );
  const r = await resolveSessionHook(
    baseInput({ cookieHeader: cookieFor(token) }),
  );
  assert.equal(r.reason, "expired-token");
  assert.equal(r.session, null);
  assert.ok(r.clearCookie);
}

// --- sid not uuid → bad-sid --------------------------------------

{
  const token = signSessionToken(
    { sid: "not-a-uuid", exp: NOW + 3600 },
    KEY,
  );
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: cookieFor(token),
      lookupSession: async () => {
        throw new Error("must not be called when sid format invalid");
      },
    }),
  );
  assert.equal(r.reason, "bad-sid");
  assert.equal(r.session, null);
  assert.ok(r.clearCookie);
}

// --- lookup returns null → no-row --------------------------------

{
  const sid = randomUUID();
  const token = signSessionToken({ sid, exp: NOW + 3600 }, KEY);
  let calledWith = null;
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: cookieFor(token),
      lookupSession: async (s) => {
        calledWith = s;
        return null;
      },
    }),
  );
  assert.equal(calledWith, sid);
  assert.equal(r.reason, "no-row");
  assert.equal(r.session, null);
  assert.ok(r.clearCookie);
}

// --- lookup throws → lookup-error, cookie kept -------------------

{
  const sid = randomUUID();
  const token = signSessionToken({ sid, exp: NOW + 3600 }, KEY);
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: cookieFor(token),
      lookupSession: async () => {
        throw new Error("db is down");
      },
    }),
  );
  assert.equal(r.reason, "lookup-error");
  assert.equal(r.session, null);
  // Cookie not cleared on transient DB outage.
  assert.equal(r.clearCookie, null);
}

// --- row expired (server-side) → expired-row --------------------

{
  const sid = randomUUID();
  const token = signSessionToken({ sid, exp: NOW + 3600 }, KEY);
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: cookieFor(token),
      lookupSession: async () => ({
        session: {
          id: sid,
          expiresAt: new Date((NOW - 10) * 1000),
        },
        user: {
          id: randomUUID(),
          email: "x@y.z",
          displayName: null,
        },
      }),
    }),
  );
  assert.equal(r.reason, "expired-row");
  assert.equal(r.session, null);
  assert.ok(r.clearCookie);
}

// --- happy path ---------------------------------------------------

{
  const sid = randomUUID();
  const userId = randomUUID();
  const exp = new Date((NOW + 3600) * 1000);
  const token = signSessionToken({ sid, exp: NOW + 3600 }, KEY);
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: cookieFor(token),
      lookupSession: async () => ({
        session: { id: sid, expiresAt: exp },
        user: {
          id: userId,
          email: "jamievicary@gmail.com",
          displayName: "Jamie",
        },
      }),
    }),
  );
  assert.equal(r.reason, "ok");
  assert.equal(r.clearCookie, null);
  assert.ok(r.session);
  assert.equal(r.session.sessionId, sid);
  assert.equal(r.session.expiresAt.getTime(), exp.getTime());
  assert.equal(r.session.user.id, userId);
  assert.equal(r.session.user.email, "jamievicary@gmail.com");
  assert.equal(r.session.user.displayName, "Jamie");
}

// --- secureCookie=false drops Secure on clear ---------------------

{
  const r = await resolveSessionHook(
    baseInput({
      cookieHeader: `${COOKIE_NAME}=not-a-token`,
      secureCookie: false,
    }),
  );
  assert.ok(r.clearCookie);
  assert.equal(r.clearCookie.includes("Secure"), false);
}

console.log("sessionHook resolver: all assertions passed");
