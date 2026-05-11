// Mint a synthetic, server-trusted session for browser tests.
//
// Playwright authed-page fixtures call this helper to bypass the
// real Google OAuth round-trip: it inserts a fresh `sessions` row
// for the given user, signs a `tc_session` cookie with the same
// HMAC key the running web tier verifies with, and returns the
// cookie value + session id + absolute expiry. The caller does
// the `page.context().addCookies(...)` step.
//
// A short TTL (default 5 minutes) is deliberate: even if a test
// crashes before its `afterAll` teardown deletes the row,
// `deleteExpiredSessions` (already a storage primitive in
// `@tex-center/db`) will sweep it within minutes — and meanwhile
// the cookie itself stops verifying via the `exp` check in
// `verifySessionToken`. No long-lived cruft accumulates.
//
// All inputs are explicit; no env reads here so the helper stays
// trivially testable.

import { signSessionToken } from "@tex-center/auth";
import { insertSession, type DrizzleDb } from "@tex-center/db";

export interface MintSessionInput {
  /** Drizzle handle pointing at the same DB the web tier is reading. */
  readonly db: DrizzleDb;
  /** HMAC key the web tier verifies session cookies with. */
  readonly signingKey: Uint8Array;
  /** users.id of the row the minted session should belong to. */
  readonly userId: string;
  /** Seconds-from-now until expiry; default 300 (5 min). */
  readonly ttlSeconds?: number;
  /**
   * Override clock for deterministic tests; default `Date.now()`.
   * Same unit as `Date.now()` (ms since epoch).
   */
  readonly nowMs?: number;
}

export interface MintedSession {
  /** `sessions.id` of the newly-inserted row. */
  readonly sid: string;
  /** Value to set as the `tc_session` cookie. */
  readonly cookieValue: string;
  /** Absolute expiry written to the DB row + encoded in the cookie. */
  readonly expiresAt: Date;
}

export async function mintSession(
  input: MintSessionInput,
): Promise<MintedSession> {
  const ttl = input.ttlSeconds ?? 300;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`mintSession: ttlSeconds must be a positive integer, got ${ttl}`);
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = new Date(nowMs + ttl * 1000);
  const row = await insertSession(input.db, {
    userId: input.userId,
    expiresAt,
  });
  // Token's exp must match the row to the second; if a future
  // change makes the DB column subsecond, round to floor to keep
  // verifySessionToken's `now >= exp` check meaningful.
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const cookieValue = signSessionToken(
    { sid: row.id, exp },
    input.signingKey,
  );
  return { sid: row.id, cookieValue, expiresAt };
}
