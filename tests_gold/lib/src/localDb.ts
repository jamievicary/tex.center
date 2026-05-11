// `local`-target DB co-location helper for Playwright authed
// tests.
//
// Decision (M8.pw.1.1.c): option (a) — PGlite-over-TCP via
// `@electric-sql/pglite-socket`. The SvelteKit dev server is a
// child process of Playwright's webServer, so cross-process
// state sharing demands an out-of-process transport. PGlite
// over a Postgres-wire TCP socket is the closest-to-prod
// transport (same `postgres-js` client path, same migrations,
// same Drizzle schema) without depending on a system Postgres
// binary or docker. The cost is a pglite major bump
// (0.2 → 0.3.16); existing in-process PGlite tests still pass
// against the bumped engine (verified in iter 84).
//
// `startLocalDb({signingKey?, seedEmail?, seedGoogleSub?})`:
//   1. Boots an in-memory PGlite, awaits readiness.
//   2. Applies the shipped migrations from
//      `packages/db/src/migrations/`.
//   3. Inserts one seed user (defaults to the allowlisted
//      `jamievicary@gmail.com`), so authed Playwright specs
//      have a row to mint sessions for.
//   4. Wraps the PGlite in a `PGLiteSocketServer` listening on
//      `127.0.0.1:0` (kernel-assigned ephemeral port).
//   5. Opens a `postgres-js` `DbHandle` against the socket so
//      the test driver can write rows the dev server will read.
//
// Returns `{ url, port, db, signingKey, userId, close() }`.
// `close()` is idempotent (multiple calls fold into one).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import {
  MIGRATIONS_TABLE_SQL,
  applyMigrations,
  closeDb,
  createDb,
  loadMigrations,
  type DbHandle,
} from "@tex-center/db";

const DEFAULT_SEED_EMAIL = "jamievicary@gmail.com";
const DEFAULT_SEED_GOOGLE_SUB = "local-test-google-sub";

export interface StartLocalDbInput {
  /**
   * 32+ bytes of entropy used to sign `tc_session` cookies. The
   * Playwright fixture must pass the same key to the SvelteKit
   * dev server (via `SESSION_SIGNING_KEY`) so cookies verify on
   * both ends. Default: 32 random bytes from `node:crypto`.
   */
  readonly signingKey?: Uint8Array;
  /** Email to seed the user row with. Default: allowlisted user. */
  readonly seedEmail?: string;
  /** `google_sub` to seed the user row with. Default: a stable test string. */
  readonly seedGoogleSub?: string;
  /**
   * Override the directory the migrations are loaded from. Test
   * seam only — defaults to `packages/db/src/migrations`.
   */
  readonly migrationsDir?: string;
}

export interface LocalDb {
  /** `postgres://...` URL the dev server should connect to. */
  readonly url: string;
  /** Kernel-assigned port the PGlite socket is listening on. */
  readonly port: number;
  /** `postgres-js`-backed Drizzle handle for the test driver. */
  readonly db: DbHandle;
  /** Signing key the dev server must use for `SESSION_SIGNING_KEY`. */
  readonly signingKey: Uint8Array;
  /** `users.id` of the seeded user; suitable for `mintSession`. */
  readonly userId: string;
  /** Idempotent teardown: closes the client, server, and PGlite. */
  close(): Promise<void>;
}

export async function startLocalDb(
  input: StartLocalDbInput = {},
): Promise<LocalDb> {
  const signingKey = input.signingKey ?? randomBytes(32);
  const seedEmail = input.seedEmail ?? DEFAULT_SEED_EMAIL;
  const seedGoogleSub = input.seedGoogleSub ?? DEFAULT_SEED_GOOGLE_SUB;
  const migrationsDir =
    input.migrationsDir ?? defaultMigrationsDir();

  const pg = await PGlite.create();
  await pg.waitReady;

  try {
    const migrations = await loadMigrations(migrationsDir);
    await applyMigrations(pgliteDriver(pg), migrations);

    const userId = randomUUID();
    await pg.query(
      "INSERT INTO users (id, email, google_sub) VALUES ($1, $2, $3)",
      [userId, seedEmail, seedGoogleSub],
    );

    const server = new PGLiteSocketServer({
      db: pg,
      host: "127.0.0.1",
      port: 0,
      // Default in pglite-socket@0.0.22 is 1, despite the docs
      // saying 100; that rejects the dev server's connection
      // the moment the test driver opens its own.
      maxConnections: 16,
    });
    await server.start();

    const port = parsePort(server.getServerConn());
    const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    // PGlite emits server-side DEBUG/NOTICE messages that
    // postgres-js's default `onnotice` handler `console.log`s;
    // silenced here to keep test output readable.
    const handle = createDb(url, { onnotice: () => {} });

    let closed = false;
    return {
      url,
      port,
      db: handle,
      signingKey,
      userId,
      async close() {
        if (closed) return;
        closed = true;
        await closeDb(handle).catch(() => {});
        await server.stop().catch(() => {});
        await pg.close().catch(() => {});
      },
    };
  } catch (err) {
    await pg.close().catch(() => {});
    throw err;
  }
}

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "packages", "db", "src", "migrations");
}

function parsePort(serverConn: string): number {
  // `PGLiteSocketServer.getServerConn()` returns `host:port`.
  const idx = serverConn.lastIndexOf(":");
  if (idx < 0) {
    throw new Error(`localDb: unexpected server conn string: ${serverConn}`);
  }
  const port = Number(serverConn.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`localDb: invalid port from server conn: ${serverConn}`);
  }
  return port;
}

interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
}

function pgliteDriver(pg: PgliteLike) {
  return {
    async ensureMigrationsTable() {
      await pg.exec(MIGRATIONS_TABLE_SQL);
    },
    async loadAppliedRows() {
      const res = await pg.query<{ name: string; sha256: string }>(
        "SELECT name, sha256 FROM schema_migrations",
      );
      return res.rows;
    },
    async applyOne(m: { name: string; sql: string; sha256: string }) {
      await pg.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.query(
          "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
          [m.name, m.sha256],
        );
      });
    },
  };
}
