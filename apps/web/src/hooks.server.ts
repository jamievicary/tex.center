// Per-request session lookup + protected-route gate.
//
// On every request: parse the `tc_session` cookie, verify its
// signature, look up the matching `sessions ⋈ users` row, and
// stash the result in `event.locals.session`. The routing
// short-circuits — protected paths with no session → `/`, and
// the sign-in page with a session → `/editor` — live in
// `$lib/server/routeRedirect.ts` so both branches are unit-tested.
//
// All the policy lives in `$lib/server/sessionHook.ts`
// (`resolveSessionHook`); this file is the SvelteKit wiring.
//
// Resilience: a missing `SESSION_SIGNING_KEY` env (e.g. early dev
// before secrets are wired) collapses to "anonymous everywhere" —
// the unauthenticated white sign-in page must keep rendering.
// A throwing DB lookup also collapses to anonymous; the cookie is
// not cleared in that case so a transient outage doesn't sign
// users out.

import type { Handle } from "@sveltejs/kit";

import { getDb } from "$lib/server/db.js";
import { routeRedirect } from "$lib/server/routeRedirect.js";
import { loadSessionSigningKey } from "$lib/server/sessionConfig.js";
import { resolveSessionHook } from "$lib/server/sessionHook.js";
import { getSessionWithUser } from "@tex-center/db";

const SESSION_COOKIE_NAME = "tc_session";

export const handle: Handle = async ({ event, resolve }) => {
  let signingKey: Uint8Array | null;
  try {
    signingKey = loadSessionSigningKey();
  } catch {
    // Malformed key in env: treat as anonymous. The operator will
    // see this when sign-in stops working; failing every request
    // hard would also break the white page.
    signingKey = null;
  }

  let clearCookie: string | null = null;

  if (signingKey !== null) {
    const result = await resolveSessionHook({
      cookieHeader: event.request.headers.get("cookie"),
      sessionCookieName: SESSION_COOKIE_NAME,
      signingKey,
      nowSeconds: Math.floor(Date.now() / 1000),
      secureCookie: event.url.protocol === "https:",
      lookupSession: async (sid) => {
        const { db } = getDb();
        return getSessionWithUser(db, sid);
      },
    });
    event.locals.session = result.session;
    clearCookie = result.clearCookie;
  } else {
    event.locals.session = null;
  }

  const redirectTo = routeRedirect({
    session: event.locals.session,
    method: event.request.method,
    pathname: event.url.pathname,
  });
  if (redirectTo !== null) {
    const headers = new Headers({
      Location: redirectTo,
      "Cache-Control": "no-store",
    });
    if (clearCookie !== null) headers.append("Set-Cookie", clearCookie);
    return new Response(null, { status: 302, headers });
  }

  const response = await resolve(event);
  if (clearCookie !== null) response.headers.append("Set-Cookie", clearCookie);
  return response;
};
