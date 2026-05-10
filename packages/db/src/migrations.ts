// SQL migration loader + applier for tex.center.
//
// `src/migrations/*.sql` is the source of truth for DDL; the
// schema test asserts `schema.ts` and the SQL agree column-by-
// column. This file's job is the runtime that consumes those
// files: read in lexicographic order, hash each, and apply
// previously-unseen ones inside a transaction that also writes
// the `schema_migrations` bookkeeping row.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';

export interface Migration {
  /** Filename minus the `.sql` extension, used as the PK in `schema_migrations`. */
  name: string;
  sql: string;
  sha256: string;
}

export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text        PRIMARY KEY,
    sha256      text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);`;

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    out.push({ name: file.replace(/\.sql$/, ''), sql, sha256 });
  }
  return out;
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

/**
 * Driver abstraction over the SQL client so `applyMigrations` can
 * run against postgres-js (prod) and PGlite (in-process gold test)
 * without duplicating the bookkeeping logic.
 */
export interface MigrationsDriver {
  /** Run `MIGRATIONS_TABLE_SQL` (idempotent). */
  ensureMigrationsTable(): Promise<void>;
  /** Return one row per already-applied migration. */
  loadAppliedRows(): Promise<{ name: string; sha256: string }[]>;
  /** Apply one migration's DDL and insert its bookkeeping row, atomically. */
  applyOne(migration: Migration): Promise<void>;
}

export async function applyMigrations(
  driver: MigrationsDriver,
  migrations: Migration[],
): Promise<ApplyResult> {
  await driver.ensureMigrationsTable();
  const rows = await driver.loadAppliedRows();
  const known = new Map(rows.map((r) => [r.name, r.sha256]));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const m of migrations) {
    const existing = known.get(m.name);
    if (existing === undefined) {
      await driver.applyOne(m);
      applied.push(m.name);
    } else if (existing !== m.sha256) {
      throw new Error(
        `Migration ${m.name} hash mismatch: db has ${existing}, file has ${m.sha256}. ` +
          `Shipped migrations must never be edited; add a new file instead.`,
      );
    } else {
      skipped.push(m.name);
    }
  }
  return { applied, skipped };
}

/**
 * Driver adapter for postgres-js's `Sql` client (the prod path).
 */
export function postgresJsDriver(sql: Sql): MigrationsDriver {
  return {
    async ensureMigrationsTable() {
      await sql.unsafe(MIGRATIONS_TABLE_SQL);
    },
    async loadAppliedRows() {
      return await sql<{ name: string; sha256: string }[]>`
        SELECT name, sha256 FROM schema_migrations
      `;
    },
    async applyOne(m) {
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`
          INSERT INTO schema_migrations (name, sha256)
          VALUES (${m.name}, ${m.sha256})
        `;
      });
    },
  };
}
