// Gold-suite test: apply the shipped migrations against an
// in-process Postgres engine (PGlite) and verify that every
// table/column declared in `schema.ts` lands as expected, and
// that re-running is a no-op. Validates the SQL DDL itself, the
// `applyMigrations` bookkeeping logic, and the `MigrationsDriver`
// seam end-to-end against a real Postgres parser/planner.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { allTables, applyMigrations, loadMigrations } from '../src/index.js';

import { pgliteDriver } from './_pgliteHarness.mjs';

// PGlite reports the SQL type via `information_schema.columns.data_type`
// (or, for arrays, `udt_name`). Our spec ColumnType set is small.
const expectedDataType = {
  uuid: 'uuid',
  text: 'text',
  bytea: 'bytea',
  bigint: 'bigint',
  integer: 'integer',
  boolean: 'boolean',
  timestamptz: 'timestamp with time zone',
  jsonb: 'jsonb',
};

const migrationsDir = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const migrations = await loadMigrations(migrationsDir);
assert.ok(migrations.length > 0, 'expected at least one migration shipped');

const pg = new PGlite();
try {
  // First apply: every shipped migration should land.
  const first = await applyMigrations(pgliteDriver(pg), migrations);
  assert.deepEqual(
    first.applied,
    migrations.map((m) => m.name),
    'first run applies every migration in order',
  );
  assert.deepEqual(first.skipped, [], 'nothing skipped on a fresh DB');

  // Second apply: identical input must be a no-op.
  const second = await applyMigrations(pgliteDriver(pg), migrations);
  assert.deepEqual(second.applied, [], 're-run applies nothing');
  assert.deepEqual(
    second.skipped,
    migrations.map((m) => m.name),
    're-run reports every migration as skipped',
  );

  // schema_migrations contains exactly the expected rows.
  const bookkeeping = await pg.query(
    'SELECT name, sha256 FROM schema_migrations ORDER BY name',
  );
  assert.deepEqual(
    bookkeeping.rows.map((r) => ({ name: r.name, sha256: r.sha256 })),
    migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    'schema_migrations rows match the shipped migration set',
  );

  // Every entity table from the spec exists, with every declared
  // column at the expected SQL type. Verifies SQL DDL is consistent
  // with `schema.ts` against a real Postgres parser (not just the
  // string-regex schema test).
  for (const t of allTables) {
    const tableRow = await pg.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [t.name],
    );
    assert.equal(tableRow.rows.length, 1, `table ${t.name} must exist after migrate`);

    const cols = await pg.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [t.name],
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    for (const spec of t.columns) {
      const got = byName.get(spec.name);
      assert.ok(got, `column ${t.name}.${spec.name} must exist`);
      assert.equal(
        got.data_type,
        expectedDataType[spec.type],
        `column ${t.name}.${spec.name} data_type`,
      );
      assert.equal(
        got.is_nullable,
        spec.nullable ? 'YES' : 'NO',
        `column ${t.name}.${spec.name} nullability`,
      );
    }
  }

  console.log(
    `migrations-pglite.test.mjs: OK (${migrations.length} migration${migrations.length === 1 ? '' : 's'}, ${allTables.length} tables)`,
  );
} finally {
  await pg.close();
}
