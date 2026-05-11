// PGlite-backed test for `mintSession`. Applies real migrations,
// inserts an allowlisted user, mints a session, then verifies:
//   - the `sessions` row exists with the expected userId + expiry,
//   - the cookie verifies cleanly via `verifySessionToken` with
//     the same signing key,
//   - the cookie fails to verify with a wrong key,
//   - the cookie reports expired at-or-after the encoded `exp`.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { verifySessionToken } from "@tex-center/auth";
import {
  applyMigrations,
  findOrCreateUserByGoogleSub,
  getSessionWithUser,
  loadMigrations,
  MIGRATIONS_TABLE_SQL,
  schema,
} from "@tex-center/db";

import { mintSession } from "../src/mintSession.ts";

function pgliteDriver(pg) {
  return {
    async ensureMigrationsTable() {
      await pg.exec(MIGRATIONS_TABLE_SQL);
    },
    async loadAppliedRows() {
      const res = await pg.query(
        "SELECT name, sha256 FROM schema_migrations",
      );
      return res.rows;
    },
    async applyOne(m) {
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

const migrationsDir = fileURLToPath(
  new URL("../../../packages/db/src/migrations/", import.meta.url),
);
const migrations = await loadMigrations(migrationsDir);

const pg = new PGlite();
try {
  await applyMigrations(pgliteDriver(pg), migrations);
  const db = /** @type {any} */ (drizzle(pg, { schema }));

  const user = await findOrCreateUserByGoogleSub(db, {
    googleSub: "test-sub",
    email: "jamievicary@gmail.com",
    displayName: "Jamie",
  });

  const signingKey = randomBytes(32);

  // Fixed clock so we can assert exp deterministically.
  const nowMs = 1_700_000_000_000;
  const minted = await mintSession({
    db,
    signingKey,
    userId: user.id,
    ttlSeconds: 300,
    nowMs,
  });

  assert.equal(typeof minted.sid, "string");
  assert.ok(minted.sid.length > 0);
  assert.equal(minted.expiresAt.getTime(), nowMs + 300_000);

  // DB row landed and points at the user.
  const row = await getSessionWithUser(db, minted.sid);
  assert.ok(row, "mintSession should leave a sessions row");
  assert.equal(row.session.id, minted.sid);
  assert.equal(row.session.userId, user.id);
  assert.equal(row.user.email, "jamievicary@gmail.com");
  // expiresAt round-trips through the DB.
  assert.equal(row.session.expiresAt.getTime(), minted.expiresAt.getTime());

  // Cookie verifies just before exp.
  const expSec = Math.floor(minted.expiresAt.getTime() / 1000);
  const okVerify = verifySessionToken(
    minted.cookieValue,
    signingKey,
    expSec - 1,
  );
  assert.equal(okVerify.ok, true, "cookie should verify at exp-1");
  if (okVerify.ok) {
    assert.equal(okVerify.payload.sid, minted.sid);
    assert.equal(okVerify.payload.exp, expSec);
  }

  // Cookie fails to verify with a different key.
  const wrongKey = randomBytes(32);
  const badKey = verifySessionToken(minted.cookieValue, wrongKey, expSec - 1);
  assert.equal(badKey.ok, false);
  if (!badKey.ok) {
    assert.equal(badKey.reason, "bad-signature");
  }

  // Cookie reports expired at exp.
  const expired = verifySessionToken(minted.cookieValue, signingKey, expSec);
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.reason, "expired");
  }

  // ttlSeconds must be a positive integer.
  await assert.rejects(
    () =>
      mintSession({
        db,
        signingKey,
        userId: user.id,
        ttlSeconds: 0,
      }),
    /ttlSeconds must be a positive integer/,
  );
  await assert.rejects(
    () =>
      mintSession({
        db,
        signingKey,
        userId: user.id,
        ttlSeconds: 1.5,
      }),
    /ttlSeconds must be a positive integer/,
  );

  console.log("mintSession.test.mjs: ok");
} finally {
  await pg.close();
}
