// Session-row insert. The cookie minted by
// `/auth/google/callback` carries the returned `id`; the
// M5.1.3 `hooks.server.ts` lookup will verify the cookie's
// signature and resolve the matching row.

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

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
