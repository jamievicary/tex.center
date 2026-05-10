// Pure orchestrator for the `hooks.server.ts` session lookup.
//
// Given the raw `Cookie` header and the injected signed-token /
// session-row primitives, decide whether the request has an
// authenticated session. Returns the resolved session (if any)
// plus a `clearCookie` directive when an existing `tc_session`
// cookie should be wiped (bad signature, expired, missing row).
//
// All I/O is injected: the caller supplies `lookupSession(sid)`.
// Failures from the lookup (DB outage) propagate as `null` —
// hooks should not let the white sign-in page break because
// Postgres is down; the user just appears anonymous.

import {
  verifySessionToken,
  type VerifyFailure,
} from "@tex-center/auth";

export interface ResolvedSessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly user: ResolvedSessionUser;
}

export interface LookupSessionResult {
  readonly session: { readonly id: string; readonly expiresAt: Date };
  readonly user: ResolvedSessionUser;
}

export type LookupSessionFn = (
  sid: string,
) => Promise<LookupSessionResult | null>;

export interface ResolveSessionHookInput {
  /** Raw `Cookie` header value, or `null` if absent. */
  readonly cookieHeader: string | null;
  readonly sessionCookieName: string;
  /** HMAC key used to sign session tokens. */
  readonly signingKey: Uint8Array;
  readonly nowSeconds: number;
  readonly secureCookie: boolean;
  readonly lookupSession: LookupSessionFn;
}

export interface ResolveSessionHookOutput {
  readonly session: ResolvedSession | null;
  /**
   * If non-null, a `Set-Cookie` value clearing the session cookie
   * (signature bad, token expired, row missing). The hook should
   * append this to the outgoing response.
   */
  readonly clearCookie: string | null;
  /**
   * Diagnostic hint for tests / logs. `null` if the request had
   * no `tc_session` cookie at all.
   */
  readonly reason:
    | null
    | "no-cookie"
    | "ok"
    | "bad-token"
    | "expired-token"
    | "bad-sid"
    | "no-row"
    | "expired-row"
    | "lookup-error";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function resolveSessionHook(
  input: ResolveSessionHookInput,
): Promise<ResolveSessionHookOutput> {
  const cookieValue = readCookie(input.cookieHeader, input.sessionCookieName);
  if (cookieValue === null) {
    return { session: null, clearCookie: null, reason: "no-cookie" };
  }

  const verified = verifySessionToken(
    cookieValue,
    input.signingKey,
    input.nowSeconds,
  );
  if (!verified.ok) {
    return {
      session: null,
      clearCookie: clearSessionCookie(
        input.sessionCookieName,
        input.secureCookie,
      ),
      reason: tokenFailureReason(verified.reason),
    };
  }

  const sid = verified.payload.sid;
  if (!UUID_RE.test(sid)) {
    return {
      session: null,
      clearCookie: clearSessionCookie(
        input.sessionCookieName,
        input.secureCookie,
      ),
      reason: "bad-sid",
    };
  }

  let row: LookupSessionResult | null;
  try {
    row = await input.lookupSession(sid);
  } catch {
    // DB outage: don't clear the cookie (the row may still be
    // valid; the user just appears anonymous this request).
    return { session: null, clearCookie: null, reason: "lookup-error" };
  }
  if (row === null) {
    return {
      session: null,
      clearCookie: clearSessionCookie(
        input.sessionCookieName,
        input.secureCookie,
      ),
      reason: "no-row",
    };
  }

  if (row.session.expiresAt.getTime() <= input.nowSeconds * 1000) {
    return {
      session: null,
      clearCookie: clearSessionCookie(
        input.sessionCookieName,
        input.secureCookie,
      ),
      reason: "expired-row",
    };
  }

  return {
    session: {
      sessionId: row.session.id,
      expiresAt: row.session.expiresAt,
      user: row.user,
    },
    clearCookie: null,
    reason: "ok",
  };
}

function tokenFailureReason(
  reason: VerifyFailure,
): "expired-token" | "bad-token" {
  return reason === "expired" ? "expired-token" : "bad-token";
}

function clearSessionCookie(name: string, secure: boolean): string {
  const attrs = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Parse a single cookie by name from a `Cookie` header value. */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq);
    if (k === name) return trimmed.slice(eq + 1);
  }
  return null;
}
