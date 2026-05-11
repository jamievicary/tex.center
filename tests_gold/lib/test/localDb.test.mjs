// End-to-end test for `startLocalDb`. Boots the PGlite socket
// server, connects via `postgres-js` (the same client the
// SvelteKit dev server uses), and verifies:
//   - migrations are applied (schema_migrations + the entity
//     tables are queryable),
//   - the seed user lands at the returned `userId`,
//   - a second `postgres-js` client (modelling the dev server)
//     can read writes made by the test driver,
//   - `close()` is idempotent and the port stops accepting.

import assert from "node:assert/strict";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { startLocalDb } from "../src/localDb.ts";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/src/migrations/", import.meta.url),
);

async function canConnect(port) {
  return await new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

async function main() {
  const local = await startLocalDb({ migrationsDir: MIGRATIONS_DIR });
  try {
    assert.ok(local.port > 0 && local.port < 65536, "port in range");
    assert.equal(typeof local.url, "string");
    assert.ok(local.url.includes(`127.0.0.1:${local.port}`));
    assert.equal(local.signingKey.length, 32);
    assert.match(
      local.userId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Seed user round-trip via the bundled DbHandle.
    const seedRows = await local.db.client`
      SELECT id, email, google_sub FROM users WHERE id = ${local.userId}
    `;
    assert.equal(seedRows.length, 1);
    assert.equal(seedRows[0].email, "jamievicary@gmail.com");
    assert.equal(seedRows[0].google_sub, "local-test-google-sub");

    // Migrations applied: schema_migrations + entity tables exist.
    const mig = await local.db.client`
      SELECT name FROM schema_migrations ORDER BY name
    `;
    assert.ok(mig.length >= 1, "at least one migration applied");
    const tables = await local.db.client`
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const names = tables.map((r) => r.tablename);
    for (const t of [
      "users",
      "sessions",
      "projects",
      "project_files",
      "machine_assignments",
      "schema_migrations",
    ]) {
      assert.ok(names.includes(t), `table ${t} missing; got ${names.join(",")}`);
    }

    // A second client (modelling the dev server's `getDb()`) sees
    // writes made through the test driver. This is the whole
    // point of the PGlite-socket transport.
    const driver = postgres(local.url, { max: 1, onnotice: () => {} });
    try {
      const read = await driver`
        SELECT email FROM users WHERE id = ${local.userId}
      `;
      assert.equal(read.length, 1);
      assert.equal(read[0].email, "jamievicary@gmail.com");

      // Insert via the test driver's DbHandle, read via the
      // "dev server" client.
      const otherId = "00000000-0000-0000-0000-000000000abc";
      await local.db.client`
        INSERT INTO users (id, email, google_sub)
        VALUES (${otherId}, ${"other@example.com"}, ${"other-sub"})
      `;
      const cross = await driver`
        SELECT email FROM users WHERE id = ${otherId}
      `;
      assert.equal(cross.length, 1);
      assert.equal(cross[0].email, "other@example.com");
    } finally {
      await driver.end({ timeout: 2 });
    }

    // Custom signing-key passthrough.
    assert.ok(await canConnect(local.port), "port is accepting before close");

    await local.close();
    await local.close(); // idempotent

    assert.equal(
      await canConnect(local.port),
      false,
      "port should stop accepting after close",
    );
  } catch (err) {
    await local.close().catch(() => {});
    throw err;
  }

  // Custom seed-email path.
  const custom = await startLocalDb({
    migrationsDir: MIGRATIONS_DIR,
    seedEmail: "alt@example.com",
    seedGoogleSub: "alt-sub",
    signingKey: new Uint8Array(32).fill(7),
  });
  try {
    const rows = await custom.db.client`
      SELECT email, google_sub FROM users WHERE id = ${custom.userId}
    `;
    assert.equal(rows[0].email, "alt@example.com");
    assert.equal(rows[0].google_sub, "alt-sub");
    assert.equal(custom.signingKey[0], 7);
  } finally {
    await custom.close();
  }

  console.log("localDb.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
