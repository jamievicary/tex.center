// POST /auth/logout
//
// Deletes the user's session row and clears the `tc_session`
// cookie. Always redirects to `/`. `event.locals.session` was
// already populated by `hooks.server.ts` from the verified cookie,
// so we know exactly which sid to delete without re-parsing.
//
// All non-POST methods return 405; CSRF posture is "POST-only +
// SameSite=Lax cookie", which is fine for a same-origin sign-out
// button. If a future iteration adds a logout-via-link affordance
// it should go through a CSRF-protected POST shim, not GET.

import type { RequestHandler } from "@sveltejs/kit";

import { deleteSession } from "@tex-center/db";

import { getDb } from "$lib/server/db.js";
import { resolveLogout } from "$lib/server/logout.js";

const SESSION_COOKIE_NAME = "tc_session";
const SIGNED_OUT_PATH = "/";

export const POST: RequestHandler = async ({ url, locals }) => {
  const result = await resolveLogout({
    sessionId: locals.session?.sessionId ?? null,
    sessionCookieName: SESSION_COOKIE_NAME,
    secureCookie: url.protocol === "https:",
    signedOutPath: SIGNED_OUT_PATH,
    deleteSession: async (sid) => {
      const { db } = getDb();
      return deleteSession(db, sid);
    },
  });

  const headers = new Headers({
    Location: result.location,
    "Cache-Control": "no-store",
  });
  for (const c of result.setCookies) headers.append("Set-Cookie", c);
  // 303 forces the post-redirect-GET pattern: the browser follows
  // with GET regardless of the original method.
  return new Response(null, { status: 303, headers });
};
