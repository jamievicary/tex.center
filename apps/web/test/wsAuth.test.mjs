// Unit test for `makeSessionAuthoriser` — wires Node IncomingMessage
// `Cookie` parsing through `resolveSessionHook` to a boolean. The
// session-hook layer is unit-tested separately; this test asserts
// the adapter passes cookies through correctly and converts
// (session !== null) into the boolean the WS proxy expects.

import assert from "node:assert/strict";

import { signSessionToken } from "@tex-center/auth";

import {
  makeProjectAccessAuthoriser,
  makeSessionAuthoriser,
} from "../src/lib/server/wsAuth.ts";

const signingKey = new Uint8Array(32).fill(7);
const NOW_MS = 1_700_000_000_000;
const nowSeconds = Math.floor(NOW_MS / 1000);

const validSid = "11111111-2222-3333-4444-555555555555";

const validToken = signSessionToken(
  { sid: validSid, exp: nowSeconds + 3600 },
  signingKey,
);

const expiresAt = new Date((nowSeconds + 3600) * 1000);

const lookupSession = async (sid) => {
  if (sid === validSid) {
    return {
      session: { id: sid, expiresAt },
      user: { id: "u1", email: "jamievicary@gmail.com", displayName: null },
    };
  }
  return null;
};

const authorise = makeSessionAuthoriser({
  signingKey,
  sessionCookieName: "tc_session",
  lookupSession,
  now: () => NOW_MS,
});

const reqWith = (cookie) => ({
  headers: cookie === null ? {} : { cookie },
});

const allow = { kind: "allow" };
const denyAnon = { kind: "deny-anon" };
const denyAcl = { kind: "deny-acl" };

// Valid cookie → allow.
assert.deepEqual(
  await authorise(reqWith(`tc_session=${validToken}`)),
  allow,
);

// Valid cookie alongside unrelated cookies → allow.
assert.deepEqual(
  await authorise(reqWith(`foo=bar; tc_session=${validToken}; other=baz`)),
  allow,
);

// No cookie header at all → deny-anon.
assert.deepEqual(await authorise(reqWith(null)), denyAnon);

// Wrong cookie name → deny-anon.
assert.deepEqual(await authorise(reqWith(`other=${validToken}`)), denyAnon);

// Tampered signature → deny-anon.
{
  const tampered = validToken.slice(0, -2) + "AA";
  assert.deepEqual(
    await authorise(reqWith(`tc_session=${tampered}`)),
    denyAnon,
  );
}

// Unknown sid (token verifies, but DB row missing) → deny-anon.
{
  const unknownSid = "deadbeef-0000-0000-0000-000000000000";
  const tokenForUnknown = signSessionToken(
    { sid: unknownSid, exp: nowSeconds + 3600 },
    signingKey,
  );
  assert.deepEqual(
    await authorise(reqWith(`tc_session=${tokenForUnknown}`)),
    denyAnon,
  );
}

// Lookup throws → swallowed inside resolveSessionHook → deny-anon.
{
  const throwing = makeSessionAuthoriser({
    signingKey,
    sessionCookieName: "tc_session",
    lookupSession: async () => {
      throw new Error("db down");
    },
    now: () => NOW_MS,
  });
  assert.deepEqual(
    await throwing(reqWith(`tc_session=${validToken}`)),
    denyAnon,
  );
}

// ---- makeProjectAccessAuthoriser ----

const ownedProject = "proj-owned";
const otherProject = "proj-other";
const missingProject = "proj-missing";

const lookupProjectOwner = async (projectId) => {
  if (projectId === ownedProject) return "u1";
  if (projectId === otherProject) return "u2";
  return null;
};

const projectAuthorise = makeProjectAccessAuthoriser({
  signingKey,
  sessionCookieName: "tc_session",
  lookupSession,
  lookupProjectOwner,
  now: () => NOW_MS,
});

// Valid session + owned project → allow.
assert.deepEqual(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), ownedProject),
  allow,
);

// Valid session + project owned by someone else → deny-acl (403).
assert.deepEqual(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), otherProject),
  denyAcl,
);

// Valid session + project that doesn't exist → deny-acl. We hide
// existence rather than telling an authed caller "404"; the proxy
// would otherwise leak a probe oracle.
assert.deepEqual(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), missingProject),
  denyAcl,
);

// No session at all → deny-anon (401), regardless of project.
assert.deepEqual(
  await projectAuthorise(reqWith(null), ownedProject),
  denyAnon,
);

// Project-owner lookup throws → deny-acl. Caller is already
// authenticated; 401 would mislead them into re-auth.
{
  const throwingProject = makeProjectAccessAuthoriser({
    signingKey,
    sessionCookieName: "tc_session",
    lookupSession,
    lookupProjectOwner: async () => {
      throw new Error("db down");
    },
    now: () => NOW_MS,
  });
  assert.deepEqual(
    await throwingProject(reqWith(`tc_session=${validToken}`), ownedProject),
    denyAcl,
  );
}

// Session lookup throws → deny-anon (caller never made it past auth).
{
  const throwingSession = makeProjectAccessAuthoriser({
    signingKey,
    sessionCookieName: "tc_session",
    lookupSession: async () => {
      throw new Error("db down");
    },
    lookupProjectOwner,
    now: () => NOW_MS,
  });
  assert.deepEqual(
    await throwingSession(reqWith(`tc_session=${validToken}`), ownedProject),
    denyAnon,
  );
}

console.log("wsAuth ok");
