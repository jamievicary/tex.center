// postgres-js connection factory wrapped around the Drizzle
// schema. Returned `db` is the typed query handle the rest of
// the codebase imports; `client` is the raw postgres-js `Sql`
// instance, used by `applyMigrations` (which needs `unsafe()` /
// `begin()` directly) and for graceful shutdown.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Options, type Sql } from 'postgres';

import { schema, type Schema } from './drizzle.js';

export interface DbHandle {
  client: Sql;
  db: PostgresJsDatabase<Schema>;
}

export function createDb(
  connectionString: string,
  options?: Options<Record<string, never>>,
): DbHandle {
  const client = postgres(connectionString, options);
  const db = drizzle(client, { schema });
  return { client, db };
}

export async function closeDb(handle: DbHandle, timeoutSeconds = 5): Promise<void> {
  await handle.client.end({ timeout: timeoutSeconds });
}
