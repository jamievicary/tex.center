// Apply pending DB migrations during control-plane boot.
//
// Production wiring (in `server.ts`) runs this before `boot()` so
// adapter-node never accepts traffic against an out-of-date schema.
// Gated by two env vars:
//
//   - `DATABASE_URL` must be set (otherwise the control plane is in
//     stateless mode — no migrations are meaningful).
//   - `RUN_MIGRATIONS_ON_BOOT` must equal "1". Defaulting off keeps
//     migrations a deliberate opt-in: only one Machine should run
//     them per deploy in a multi-Machine future, and ops may want
//     to run them out-of-band via `pnpm --filter @tex-center/db
//     db:migrate` against a `flyctl proxy`.
//
// The implementation is split into a pure `runBootMigrations(env,
// deps)` driver plus a `defaultBootMigrationsDeps` adapter so tests
// can substitute the loader/applier without standing up Postgres.

import {
  applyMigrations,
  closeDb,
  createDb,
  loadMigrations,
  postgresJsDriver,
  type ApplyResult,
  type Migration,
} from "@tex-center/db";

export type BootMigrationsStatus =
  | { kind: "skipped-no-database-url" }
  | { kind: "skipped-disabled" }
  | { kind: "no-migrations-found"; dir: string }
  | { kind: "applied"; applied: readonly string[]; skipped: readonly string[] };

export interface BootMigrationsDeps {
  loadFromDir(dir: string): Promise<Migration[]>;
  applyWith(url: string, migrations: Migration[]): Promise<ApplyResult>;
}

export const DEFAULT_MIGRATIONS_DIR = "/app/migrations";

export const defaultBootMigrationsDeps: BootMigrationsDeps = {
  loadFromDir: (dir) => loadMigrations(dir),
  applyWith: async (url, migrations) => {
    const handle = createDb(url, { max: 1, onnotice: () => {} });
    try {
      return await applyMigrations(postgresJsDriver(handle.client), migrations);
    } finally {
      await closeDb(handle);
    }
  },
};

export async function runBootMigrations(
  env: Readonly<Record<string, string | undefined>>,
  deps: BootMigrationsDeps = defaultBootMigrationsDeps,
): Promise<BootMigrationsStatus> {
  const url = env.DATABASE_URL;
  if (!url) return { kind: "skipped-no-database-url" };
  if (env.RUN_MIGRATIONS_ON_BOOT !== "1") return { kind: "skipped-disabled" };

  const dir = env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR;
  const migrations = await deps.loadFromDir(dir);
  if (migrations.length === 0) return { kind: "no-migrations-found", dir };

  const result = await deps.applyWith(url, migrations);
  return {
    kind: "applied",
    applied: result.applied,
    skipped: result.skipped,
  };
}

export function describeBootMigrationsStatus(s: BootMigrationsStatus): string {
  switch (s.kind) {
    case "skipped-no-database-url":
      return "migrations: skipped (DATABASE_URL not set)";
    case "skipped-disabled":
      return "migrations: skipped (RUN_MIGRATIONS_ON_BOOT != \"1\")";
    case "no-migrations-found":
      return `migrations: no .sql files found in ${s.dir}`;
    case "applied":
      return `migrations: ${s.applied.length} applied, ${s.skipped.length} already present` +
        (s.applied.length > 0 ? ` (${s.applied.join(", ")})` : "");
  }
}
