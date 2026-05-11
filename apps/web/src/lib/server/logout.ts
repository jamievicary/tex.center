// Pure orchestrator for `POST /auth/logout`.
//
// On a logout POST: if the request carries a session in
// `event.locals` (already verified by `hooks.server.ts`), delete
// the matching DB row. Always emit a clear-cookie + 303 redirect to
// the signed-out page, even when no session was present (so
// double-clicks and forged cookies still produce a clean
// terminal state).
//
// The DB delete is injected so this module remains I/O-free; the
// route file binds it to `deleteSession(db, sid)` from
// `@tex-center/db`. A throwing delete propagates — logout failing
// on a transient DB blip is preferable to telling the user they're
// signed out while the row still exists.
//
// Method gating: only `POST` is valid. `GET /auth/logout` is
// reserved (a future link-driven flow can route through a CSRF-
// safe POST shim); the route file maps anything else to 405.

import { formatClearCookie } from "./cookies.js";

export interface ResolveLogoutInput {
  /** Verified session id from `event.locals.session`, or `null`. */
  readonly sessionId: string | null;
  readonly sessionCookieName: string;
  readonly secureCookie: boolean;
  readonly signedOutPath: string;
  readonly deleteSession: (sid: string) => Promise<boolean>;
}

export interface ResolveLogoutOutput {
  readonly location: string;
  readonly setCookies: readonly string[];
  /** Diagnostic hint for tests/logs. */
  readonly reason: "deleted" | "no-row" | "no-session";
}

export async function resolveLogout(
  input: ResolveLogoutInput,
): Promise<ResolveLogoutOutput> {
  let reason: ResolveLogoutOutput["reason"];
  if (input.sessionId === null) {
    reason = "no-session";
  } else {
    const deleted = await input.deleteSession(input.sessionId);
    reason = deleted ? "deleted" : "no-row";
  }
  return {
    location: input.signedOutPath,
    setCookies: [
      formatClearCookie({
        name: input.sessionCookieName,
        path: "/",
        secure: input.secureCookie,
      }),
    ],
    reason,
  };
}
