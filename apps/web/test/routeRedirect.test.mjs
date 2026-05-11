// Unit tests for the pure routing-policy helper.
//
// `hooks.server.ts` delegates the redirect decision to
// `routeRedirect`; this file pins both branches plus the
// no-redirect cases so a future refactor of the hook can't
// silently drop a rule.

import assert from "node:assert/strict";

import {
  PROTECTED_PREFIXES,
  SIGNED_IN_HOME,
  SIGNED_OUT_PATH,
  routeRedirect,
} from "../src/lib/server/routeRedirect.ts";

const SESSION = {
  sessionId: "00000000-0000-0000-0000-000000000000",
  expiresAt: new Date(0),
  user: { id: "u", email: "u@example.com", displayName: null },
};

// Unauth → protected: redirect to `/`.
assert.equal(
  routeRedirect({ session: null, method: "GET", pathname: "/editor" }),
  SIGNED_OUT_PATH,
);
// Method-agnostic: a POST to a protected path still bounces.
assert.equal(
  routeRedirect({ session: null, method: "POST", pathname: "/editor" }),
  SIGNED_OUT_PATH,
);
// Prefix match, not exact: `/editor/foo` is also protected.
assert.equal(
  routeRedirect({ session: null, method: "GET", pathname: "/editor/abc" }),
  SIGNED_OUT_PATH,
);

// Authed → sign-in page: redirect to `/editor`.
assert.equal(
  routeRedirect({ session: SESSION, method: "GET", pathname: "/" }),
  SIGNED_IN_HOME,
);
// POST to `/` is left alone (no future form should be silently
// redirected away from the white page).
assert.equal(
  routeRedirect({ session: SESSION, method: "POST", pathname: "/" }),
  null,
);

// Authed visiting a protected path: no redirect.
assert.equal(
  routeRedirect({ session: SESSION, method: "GET", pathname: "/editor" }),
  null,
);
// Unauth visiting `/`: no redirect (the white page renders).
assert.equal(
  routeRedirect({ session: null, method: "GET", pathname: "/" }),
  null,
);
// Unauth visiting an unprotected path: no redirect.
assert.equal(
  routeRedirect({ session: null, method: "GET", pathname: "/auth/google" }),
  null,
);
// Authed visiting an unprotected, non-signin path: no redirect.
assert.equal(
  routeRedirect({ session: SESSION, method: "GET", pathname: "/auth/logout" }),
  null,
);

// Sanity: the exported config matches what the hook used to
// hard-code. A future change here is a deliberate policy edit.
assert.deepEqual([...PROTECTED_PREFIXES], ["/editor"]);
assert.equal(SIGNED_IN_HOME, "/editor");
assert.equal(SIGNED_OUT_PATH, "/");

console.log("routeRedirect ok");
