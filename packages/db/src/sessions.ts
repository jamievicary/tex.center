// Session-row insert. The cookie minted by
// `/auth/google/callback` carries the returned `id`; the
// M5.1.3 `hooks.server.ts` lookup will verify the cookie's
// signature and resolve the matching row.

import { randomUUID } from 'node:crypto';

import { eq, lt } from 'drizzle-orm';

import { sessions, users } from './drizzle.js';
import type { SessionRow, UserRow } from './schema.js';
import type { DrizzleDb } from './users.js';

export interface InsertSessionInput {
  readonly userId: string;
  readonly expiresAt: Date;
}

export async function insertSession(
  db: DrizzleDb,
  input: InsertSessionInput,
): Promise<SessionRow> {
  const rows = await db
    .insert(sessions)
    .values({
      id: randomUUID(),
      userId: input.userId,
      expiresAt: input.expiresAt,
    })
    .returning();
  const r = rows[0];
  if (!r) throw new Error('insertSession: no row returned');
  return r;
}

export interface SessionWithUser {
  readonly session: SessionRow;
  readonly user: UserRow;
}

/**
 * Look up a session by id, joined with its owning user. Returns
 * `null` if no row matches.
 *
 * The caller is responsible for the wall-clock expiry check
 * against `session.expiresAt`; this helper is a pure storage
 * lookup so it can be reused by sweepers / admin tools that
 * legitimately want expired rows.
 */
export async function getSessionWithUser(
  db: DrizzleDb,
  sid: string,
): Promise<SessionWithUser | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sid))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { session: r.session, user: r.user };
}

/**
 * Delete a session row by id. Returns `true` if a row was deleted,
 * `false` if no row matched. Used by `/auth/logout`; harmless on
 * unknown sids so a stale/forged cookie posting to the route just
 * no-ops on the DB side and still gets a clear-cookie response.
 */
export async function deleteSession(
  db: DrizzleDb,
  sid: string,
): Promise<boolean> {
  const rows = await db
    .delete(sessions)
    .where(eq(sessions.id, sid))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/**
 * Delete all session rows whose `expires_at` is strictly before
 * `now`. Returns the number of rows removed. Safe to call
 * concurrently with `getSessionWithUser` — `hooks.server.ts`
 * already treats an expired-row hit as "no session" and clears
 * the cookie, so a swept row mid-request is observationally
 * identical to one that lingered briefly post-expiry.
 *
 * No periodic caller exists yet; this is the storage primitive a
 * future sweeper (cron, on-boot pass, admin tool) will use.
 */
export async function deleteExpiredSessions(
  db: DrizzleDb,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return rows.length;
}
