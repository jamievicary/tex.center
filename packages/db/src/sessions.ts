// Session-row insert. The cookie minted by
// `/auth/google/callback` carries the returned `id`; the
// M5.1.3 `hooks.server.ts` lookup will verify the cookie's
// signature and resolve the matching row.

import { randomUUID } from 'node:crypto';

import { sessions } from './drizzle.js';
import type { SessionRow } from './schema.js';
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
