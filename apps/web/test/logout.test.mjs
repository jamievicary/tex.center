// Unit test for `resolveLogout`. Every `reason` branch is covered
// with stubbed I/O.

import assert from "node:assert/strict";

import { resolveLogout } from "../src/lib/server/logout.ts";

const COOKIE = "tc_session";

function baseInput(overrides = {}) {
  return {
    sessionId: null,
    sessionCookieName: COOKIE,
    secureCookie: true,
    signedOutPath: "/",
    deleteSession: async () => {
      throw new Error("deleteSession should not be called");
    },
    ...overrides,
  };
}

function assertClearCookie(value, { secure }) {
  // `name=` with empty value + Path=/ + HttpOnly + SameSite=Lax +
  // Max-Age=0 (+ Secure if applicable).
  assert.match(value, new RegExp(`^${COOKIE}=;`));
  assert.match(value, /Path=\//);
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Max-Age=0/);
  if (secure) assert.match(value, /Secure/);
  else assert.doesNotMatch(value, /Secure/);
}

// --- no session: redirect + clear-cookie, no DB call ---------------

{
  const r = await resolveLogout(baseInput());
  assert.equal(r.reason, "no-session");
  assert.equal(r.location, "/");
  assert.equal(r.setCookies.length, 1);
  assertClearCookie(r.setCookies[0], { secure: true });
}

// --- session present, row found -----------------------------------

{
  const calls = [];
  const r = await resolveLogout(
    baseInput({
      sessionId: "abc",
      deleteSession: async (sid) => {
        calls.push(sid);
        return true;
      },
    }),
  );
  assert.equal(r.reason, "deleted");
  assert.deepEqual(calls, ["abc"]);
  assert.equal(r.location, "/");
  assertClearCookie(r.setCookies[0], { secure: true });
}

// --- session present, row already gone (race / double-click) ------

{
  const r = await resolveLogout(
    baseInput({
      sessionId: "abc",
      deleteSession: async () => false,
    }),
  );
  assert.equal(r.reason, "no-row");
  assert.equal(r.location, "/");
  assertClearCookie(r.setCookies[0], { secure: true });
}

// --- delete throws: error propagates ------------------------------

{
  let caught;
  try {
    await resolveLogout(
      baseInput({
        sessionId: "abc",
        deleteSession: async () => {
          throw new Error("db down");
        },
      }),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /db down/);
}

// --- secureCookie=false (dev over http) ---------------------------

{
  const r = await resolveLogout(
    baseInput({
      secureCookie: false,
    }),
  );
  assertClearCookie(r.setCookies[0], { secure: false });
}

// --- alternative signedOutPath honoured ---------------------------

{
  const r = await resolveLogout(
    baseInput({
      signedOutPath: "/goodbye",
    }),
  );
  assert.equal(r.location, "/goodbye");
}

console.log("logout test: OK");
