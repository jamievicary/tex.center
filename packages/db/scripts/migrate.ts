// CLI: `pnpm --filter @tex-center/db db:migrate`.
//
// Reads `DATABASE_URL` from the environment, loads every
// `src/migrations/*.sql` in lexicographic order, and applies
// the unseen ones inside transactions that also write the
// `schema_migrations` bookkeeping row.

import { fileURLToPath } from 'node:url';

import {
  applyMigrations,
  closeDb,
  createDb,
  loadMigrations,
  postgresJsDriver,
} from '../src/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('migrate: DATABASE_URL is required');
    process.exit(2);
  }

  const migrationsDir = fileURLToPath(new URL('../src/migrations/', import.meta.url));
  const migrations = await loadMigrations(migrationsDir);
  if (migrations.length === 0) {
    console.error(`migrate: no migrations found in ${migrationsDir}`);
    process.exit(2);
  }

  const handle = createDb(url, { max: 1, onnotice: () => {} });
  try {
    const result = await applyMigrations(postgresJsDriver(handle.client), migrations);
    for (const name of result.applied) console.log(`applied ${name}`);
    for (const name of result.skipped) console.log(`skipped ${name} (already applied)`);
    console.log(`migrate: ${result.applied.length} applied, ${result.skipped.length} skipped`);
  } finally {
    await closeDb(handle);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
