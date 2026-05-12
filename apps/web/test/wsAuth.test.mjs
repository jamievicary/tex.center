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

// Valid cookie → true.
assert.equal(await authorise(reqWith(`tc_session=${validToken}`)), true);

// Valid cookie alongside unrelated cookies → still true.
assert.equal(
  await authorise(reqWith(`foo=bar; tc_session=${validToken}; other=baz`)),
  true,
);

// No cookie header at all → false.
assert.equal(await authorise(reqWith(null)), false);

// Wrong cookie name → false.
assert.equal(await authorise(reqWith(`other=${validToken}`)), false);

// Tampered signature → false.
{
  const tampered = validToken.slice(0, -2) + "AA";
  assert.equal(await authorise(reqWith(`tc_session=${tampered}`)), false);
}

// Unknown sid (token verifies, but DB row missing) → false.
{
  const unknownSid = "deadbeef-0000-0000-0000-000000000000";
  const tokenForUnknown = signSessionToken(
    { sid: unknownSid, exp: nowSeconds + 3600 },
    signingKey,
  );
  assert.equal(
    await authorise(reqWith(`tc_session=${tokenForUnknown}`)),
    false,
  );
}

// Lookup throws → authoriser must still resolve cleanly (and to false).
{
  const throwing = makeSessionAuthoriser({
    signingKey,
    sessionCookieName: "tc_session",
    lookupSession: async () => {
      throw new Error("db down");
    },
    now: () => NOW_MS,
  });
  assert.equal(
    await throwing(reqWith(`tc_session=${validToken}`)),
    false,
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

// Valid session + owned project → true.
assert.equal(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), ownedProject),
  true,
);

// Valid session + project owned by someone else → false.
assert.equal(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), otherProject),
  false,
);

// Valid session + project that doesn't exist → false (no Machine
// spawn for a hand-typed projectId).
assert.equal(
  await projectAuthorise(reqWith(`tc_session=${validToken}`), missingProject),
  false,
);

// No session at all → false, regardless of project.
assert.equal(await projectAuthorise(reqWith(null), ownedProject), false);

// Project-owner lookup throws → false (DB outage must not admit).
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
  assert.equal(
    await throwingProject(reqWith(`tc_session=${validToken}`), ownedProject),
    false,
  );
}

// Session lookup throws → false even when project resolves.
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
  assert.equal(
    await throwingSession(reqWith(`tc_session=${validToken}`), ownedProject),
    false,
  );
}

console.log("wsAuth ok");
