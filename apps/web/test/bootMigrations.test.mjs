// Env-gating + dependency-wiring tests for `runBootMigrations`.
// Covers each branch of the status enum without touching Postgres
// or the filesystem. The default deps adapter wraps
// `loadMigrations` / `applyMigrations` and is exercised indirectly
// via the `@tex-center/db` test suite.

import assert from "node:assert/strict";

import {
  DEFAULT_MIGRATIONS_DIR,
  describeBootMigrationsStatus,
  runBootMigrations,
} from "../src/lib/server/bootMigrations.ts";

function makeStubDeps() {
  const calls = { load: [], apply: [] };
  return {
    calls,
    loadFromDir: async (dir) => {
      calls.load.push(dir);
      return [
        { name: "0001_initial", sql: "CREATE TABLE t ()", sha256: "deadbeef" },
      ];
    },
    applyWith: async (url, migrations) => {
      calls.apply.push({ url, migrations });
      return { applied: ["0001_initial"], skipped: [] };
    },
  };
}

async function test_skipped_when_no_database_url() {
  const deps = makeStubDeps();
  const status = await runBootMigrations(
    { RUN_MIGRATIONS_ON_BOOT: "1" },
    deps,
  );
  assert.deepEqual(status, { kind: "skipped-no-database-url" });
  assert.equal(deps.calls.load.length, 0);
  assert.equal(deps.calls.apply.length, 0);
}

async function test_skipped_when_flag_off() {
  const deps = makeStubDeps();
  const status = await runBootMigrations(
    { DATABASE_URL: "postgres://x" },
    deps,
  );
  assert.deepEqual(status, { kind: "skipped-disabled" });
  assert.equal(deps.calls.load.length, 0);
  assert.equal(deps.calls.apply.length, 0);
}

async function test_skipped_when_flag_not_exactly_one() {
  const deps = makeStubDeps();
  for (const value of ["0", "true", "yes", " 1", ""]) {
    const status = await runBootMigrations(
      { DATABASE_URL: "postgres://x", RUN_MIGRATIONS_ON_BOOT: value },
      deps,
    );
    assert.deepEqual(status, { kind: "skipped-disabled" });
  }
  assert.equal(deps.calls.apply.length, 0);
}

async function test_applies_with_default_dir() {
  const deps = makeStubDeps();
  const status = await runBootMigrations(
    { DATABASE_URL: "postgres://x", RUN_MIGRATIONS_ON_BOOT: "1" },
    deps,
  );
  assert.deepEqual(status, {
    kind: "applied",
    applied: ["0001_initial"],
    skipped: [],
  });
  assert.deepEqual(deps.calls.load, [DEFAULT_MIGRATIONS_DIR]);
  assert.equal(deps.calls.apply.length, 1);
  assert.equal(deps.calls.apply[0].url, "postgres://x");
}

async function test_applies_with_override_dir() {
  const deps = makeStubDeps();
  await runBootMigrations(
    {
      DATABASE_URL: "postgres://x",
      RUN_MIGRATIONS_ON_BOOT: "1",
      MIGRATIONS_DIR: "/tmp/elsewhere",
    },
    deps,
  );
  assert.deepEqual(deps.calls.load, ["/tmp/elsewhere"]);
}

async function test_no_migrations_found() {
  const deps = {
    loadFromDir: async () => [],
    applyWith: async () => {
      throw new Error("should not be called when no migrations exist");
    },
  };
  const status = await runBootMigrations(
    { DATABASE_URL: "postgres://x", RUN_MIGRATIONS_ON_BOOT: "1" },
    deps,
  );
  assert.deepEqual(status, {
    kind: "no-migrations-found",
    dir: DEFAULT_MIGRATIONS_DIR,
  });
}

async function test_describe_status_strings() {
  assert.match(
    describeBootMigrationsStatus({ kind: "skipped-no-database-url" }),
    /DATABASE_URL not set/,
  );
  assert.match(
    describeBootMigrationsStatus({ kind: "skipped-disabled" }),
    /RUN_MIGRATIONS_ON_BOOT/,
  );
  assert.match(
    describeBootMigrationsStatus({ kind: "no-migrations-found", dir: "/d" }),
    /\/d/,
  );
  const applied = describeBootMigrationsStatus({
    kind: "applied",
    applied: ["0001_initial"],
    skipped: ["0000_legacy"],
  });
  assert.match(applied, /1 applied/);
  assert.match(applied, /1 already present/);
  assert.match(applied, /0001_initial/);
}

async function test_apply_error_propagates() {
  const deps = {
    loadFromDir: async () => [
      { name: "0001_initial", sql: "x", sha256: "h" },
    ],
    applyWith: async () => {
      throw new Error("boom");
    },
  };
  await assert.rejects(
    runBootMigrations(
      { DATABASE_URL: "postgres://x", RUN_MIGRATIONS_ON_BOOT: "1" },
      deps,
    ),
    /boom/,
  );
}

const tests = [
  test_skipped_when_no_database_url,
  test_skipped_when_flag_off,
  test_skipped_when_flag_not_exactly_one,
  test_applies_with_default_dir,
  test_applies_with_override_dir,
  test_no_migrations_found,
  test_describe_status_strings,
  test_apply_error_propagates,
];

for (const t of tests) {
  await t();
  console.log("ok", t.name);
}
