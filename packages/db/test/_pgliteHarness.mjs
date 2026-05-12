// Shared PGlite test harness.
//
// Every gold-suite Node script under this directory boots an
// in-process PGlite, applies the shipped migrations, and then
// exercises the storage helpers. The migrations driver shim and
// the boilerplate to load + apply migrations from
// `../src/migrations/` are identical across files; this module
// is the canonical copy.

import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import {
  MIGRATIONS_TABLE_SQL,
  applyMigrations,
  loadMigrations,
} from '../src/index.js';

/**
 * Build a `MigrationsDriver` against an in-process PGlite engine.
 * Mirrors the production driver's shape (ensure-table, load-rows,
 * apply-one-in-transaction) so `applyMigrations` is exercised end
 * to end against a real Postgres parser.
 */
export function pgliteDriver(pg) {
  return {
    async ensureMigrationsTable() {
      await pg.exec(MIGRATIONS_TABLE_SQL);
    },
    async loadAppliedRows() {
      const res = await pg.query('SELECT name, sha256 FROM schema_migrations');
      return res.rows;
    },
    async applyOne(m) {
      await pg.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.query(
          'INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)',
          [m.name, m.sha256],
        );
      });
    },
  };
}

/**
 * Open a fresh PGlite, apply the shipped migrations, return
 * `{ pg, migrations }`. Caller is responsible for `pg.close()`.
 */
export async function freshMigratedPglite() {
  const migrationsDir = fileURLToPath(
    new URL('../src/migrations/', import.meta.url),
  );
  const migrations = await loadMigrations(migrationsDir);
  const pg = new PGlite();
  await applyMigrations(pgliteDriver(pg), migrations);
  return { pg, migrations };
}
