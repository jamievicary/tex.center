// User-row CRUD: today, only the OAuth-driven upsert.
//
// `findOrCreateUserByGoogleSub` is called from `apps/web`'s
// `/auth/google/callback` once Google's ID token has been verified
// and the email allowlist passes. It inserts a fresh row keyed on
// `google_sub` or refreshes `email` / `display_name` / `updated_at`
// on a returning user, all in one round-trip.

import { randomUUID } from 'node:crypto';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { users, type Schema } from './drizzle.js';
import type { UserRow } from './schema.js';

export interface FindOrCreateUserInput {
  readonly googleSub: string;
  readonly email: string;
  readonly displayName?: string | null;
}

// Both prod (postgres-js) and tests (PGlite) call into the same
// Drizzle query builder; the prod type is precise enough that we
// can keep the helper strongly typed and cast at the call site
// in PGlite tests.
export type DrizzleDb = PostgresJsDatabase<Schema>;

export async function findOrCreateUserByGoogleSub(
  db: DrizzleDb,
  input: FindOrCreateUserInput,
): Promise<UserRow> {
  const displayName = input.displayName ?? null;
  const rows = await db
    .insert(users)
    .values({
      id: randomUUID(),
      googleSub: input.googleSub,
      email: input.email,
      displayName,
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email: input.email,
        displayName,
        updatedAt: new Date(),
      },
    })
    .returning();
  const r = rows[0];
  if (!r) throw new Error('findOrCreateUserByGoogleSub: no row returned');
  return r;
}
