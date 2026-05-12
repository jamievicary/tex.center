// Pure-JS test for the SQL migration loader. The `applyMigrations`
// runtime is exercised against real Postgres in the gold suite
// once docker-compose lands (M4.2.1).

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { loadMigrations, MIGRATIONS_TABLE_SQL } from '../src/index.js';

const migrationsDir = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const migrations = await loadMigrations(migrationsDir);

assert.equal(migrations.length, 2, 'expected two migrations shipped today');

assert.deepEqual(
  migrations.map((m) => m.name),
  ['0001_initial', '0002_drop_users_email_unique'],
);

const first = migrations[0];
assert.match(first.sql, /CREATE TABLE users\b/);
assert.match(first.sql, /CREATE TABLE machine_assignments\b/);
assert.match(first.sha256, /^[0-9a-f]{64}$/, 'sha256 must be lowercase hex');

const second = migrations[1];
assert.match(second.sql, /DROP CONSTRAINT IF EXISTS users_email_key/);
assert.match(second.sha256, /^[0-9a-f]{64}$/, 'sha256 must be lowercase hex');

// Loader must yield lexicographic order. Forge a synthetic case
// by re-loading on the parent dir is unsafe; instead assert on a
// tmp dir we create.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'tex-center-mig-'));
await writeFile(join(tmp, '0010_b.sql'), 'select 2;');
await writeFile(join(tmp, '0002_a.sql'), 'select 1;');
await writeFile(join(tmp, 'README.txt'), 'ignored');
const ordered = await loadMigrations(tmp);
assert.deepEqual(
  ordered.map((m) => m.name),
  ['0002_a', '0010_b'],
  'lexicographic order, .sql only',
);

assert.match(MIGRATIONS_TABLE_SQL, /schema_migrations/);
assert.match(MIGRATIONS_TABLE_SQL, /name\s+text\s+PRIMARY KEY/);

console.log(`migrations.test.mjs: OK (${migrations.length} migration${migrations.length === 1 ? '' : 's'})`);
