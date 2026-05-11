// Playwright globalSetup: boots a PGlite-over-TCP DB for the
// `local` target and exports `DATABASE_URL`,
// `SESSION_SIGNING_KEY`, and `TEXCENTER_LOCAL_USER_ID` so:
//   - the SvelteKit dev server (spawned as a child by
//     `webServer` in `playwright.config.ts`) connects to the
//     same Postgres-wire endpoint the test driver uses, and
//     verifies cookies with the same HMAC key the
//     `authedPage` fixture signs with;
//   - the `authedPage` fixture's `db` worker fixture resolves
//     these env vars to mint sessions for the seeded user.
//
// Skipped when `PLAYWRIGHT_SKIP_WEBSERVER=1` (the `live`
// target, which uses flyctl-proxied Postgres instead).
//
// Returns its own teardown — the recommended Playwright
// pattern — so we don't need to share state across modules
// for a separate `globalTeardown` hook.

import { join } from "node:path";

import { startLocalDb, type LocalDb } from "../lib/src/localDb.js";

// Resolved relative to this file's directory at runtime.
// Playwright transpiles globalSetup as CJS, so `__dirname` is
// available. Layout: tests_gold/playwright/globalSetup.ts →
// ../../packages/db/src/migrations.
const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "packages",
  "db",
  "src",
  "migrations",
);

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1") {
    return async () => {};
  }
  const local: LocalDb = await startLocalDb({
    migrationsDir: MIGRATIONS_DIR,
  });
  process.env.DATABASE_URL = local.url;
  process.env.SESSION_SIGNING_KEY = Buffer.from(local.signingKey).toString(
    "base64url",
  );
  process.env.TEXCENTER_LOCAL_USER_ID = local.userId;
  return async () => {
    await local.close();
  };
}
