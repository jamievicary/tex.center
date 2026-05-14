// Env-gating + dependency-wiring tests for `runBootSessionSweep`.
// Mirrors `bootMigrations.test.mjs`: each branch of the status
// enum is exercised through a stubbed `sweep` so no Postgres or
// network is required. The default deps adapter (which opens a
// real connection) is exercised indirectly via the @tex-center/db
// session-sweep tests.

import assert from "node:assert/strict";

import {
  describeSessionSweepStatus,
  runBootSessionSweep,
} from "../src/lib/server/sessionSweep.ts";

function makeStubDeps(removed = 0) {
  const calls = [];
  return {
    calls,
    sweep: async (url, now) => {
      calls.push({ url, now });
      return removed;
    },
  };
}

async function test_skipped_when_no_database_url() {
  const deps = makeStubDeps();
  const status = await runBootSessionSweep(
    { SWEEP_SESSIONS_ON_BOOT: "1" },
    deps,
  );
  assert.deepEqual(status, { kind: "skipped-no-database-url" });
  assert.equal(deps.calls.length, 0);
}

async function test_skipped_when_flag_off() {
  const deps = makeStubDeps();
  const status = await runBootSessionSweep(
    { DATABASE_URL: "postgres://x" },
    deps,
  );
  assert.deepEqual(status, { kind: "skipped-disabled" });
  assert.equal(deps.calls.length, 0);
}

async function test_skipped_when_flag_not_exactly_one() {
  const deps = makeStubDeps();
  for (const value of ["0", "true", "yes", " 1", ""]) {
    const status = await runBootSessionSweep(
      { DATABASE_URL: "postgres://x", SWEEP_SESSIONS_ON_BOOT: value },
      deps,
    );
    assert.deepEqual(status, { kind: "skipped-disabled" });
  }
  assert.equal(deps.calls.length, 0);
}

async function test_sweeps_when_enabled() {
  const deps = makeStubDeps(3);
  const now = new Date("2026-05-14T12:00:00Z");
  const status = await runBootSessionSweep(
    { DATABASE_URL: "postgres://x", SWEEP_SESSIONS_ON_BOOT: "1" },
    deps,
    now,
  );
  assert.deepEqual(status, { kind: "swept", removed: 3 });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].url, "postgres://x");
  assert.equal(deps.calls[0].now.getTime(), now.getTime());
}

async function test_sweep_error_propagates() {
  const deps = {
    sweep: async () => {
      throw new Error("boom");
    },
  };
  await assert.rejects(
    runBootSessionSweep(
      { DATABASE_URL: "postgres://x", SWEEP_SESSIONS_ON_BOOT: "1" },
      deps,
    ),
    /boom/,
  );
}

async function test_describe_status_strings() {
  assert.match(
    describeSessionSweepStatus({ kind: "skipped-no-database-url" }),
    /DATABASE_URL not set/,
  );
  assert.match(
    describeSessionSweepStatus({ kind: "skipped-disabled" }),
    /SWEEP_SESSIONS_ON_BOOT/,
  );
  assert.match(
    describeSessionSweepStatus({ kind: "swept", removed: 0 }),
    /removed 0 expired rows/,
  );
  assert.match(
    describeSessionSweepStatus({ kind: "swept", removed: 1 }),
    /removed 1 expired row\b/,
  );
  assert.match(
    describeSessionSweepStatus({ kind: "swept", removed: 5 }),
    /removed 5 expired rows/,
  );
}

const tests = [
  test_skipped_when_no_database_url,
  test_skipped_when_flag_off,
  test_skipped_when_flag_not_exactly_one,
  test_sweeps_when_enabled,
  test_sweep_error_propagates,
  test_describe_status_strings,
];

for (const t of tests) {
  await t();
  console.log("ok", t.name);
}
