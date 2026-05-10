// `/healthz` reports the state of the optional DB handle:
//   - no handle               → { state: "absent" }, ok: true
//   - handle, probe succeeds  → { state: "up"     }, ok: true
//   - handle, probe throws    → { state: "down", error }, ok: false
//
// The probe is `client\`SELECT 1\``; we fake `client` as a
// tagged-template function so the test stays free of postgres-js.

import assert from "node:assert/strict";

import { buildServer } from "../src/server.ts";

function fakeClientOk() {
  const calls = [];
  const sql = (strings) => {
    calls.push(strings.join("?"));
    return Promise.resolve([{ ok: 1 }]);
  };
  sql.end = async () => {};
  return { sql, calls };
}

function fakeClientFail(message) {
  const sql = () => Promise.reject(new Error(message));
  sql.end = async () => {};
  return sql;
}

async function getHealth(app) {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  return res.json();
}

// 1. No db.
{
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const app = await buildServer({ logger: false });
    const body = await getHealth(app);
    assert.equal(body.ok, true);
    assert.deepEqual(body.db, { state: "absent" });
    assert.equal(typeof body.protocol, "number");
    await app.close();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

// 2. db handle, probe succeeds.
{
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { sql, calls } = fakeClientOk();
    const app = await buildServer({
      logger: false,
      db: { client: sql, db: {} },
    });
    const body = await getHealth(app);
    assert.equal(body.ok, true);
    assert.deepEqual(body.db, { state: "up" });
    assert.equal(calls.length, 1, "probe must call client exactly once per request");
    assert.match(calls[0], /SELECT 1/);
    // Calling again should run another probe.
    await getHealth(app);
    assert.equal(calls.length, 2);
    await app.close();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

// 3. db handle, probe throws.
{
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const sql = fakeClientFail("connection refused");
    const app = await buildServer({
      logger: false,
      db: { client: sql, db: {} },
    });
    const body = await getHealth(app);
    assert.equal(body.ok, false);
    assert.equal(body.db.state, "down");
    assert.equal(body.db.error, "connection refused");
    await app.close();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

console.log("serverHealth.test.mjs OK");
