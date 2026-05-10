// Verifies how `buildServer` wires the optional `@tex-center/db`
// DbHandle:
//   1. No DATABASE_URL, no injection → app.db === null.
//   2. Caller-injected db → app.db === injected; not closed on
//      app.close() (caller owns the lifecycle).
//   3. DATABASE_URL set, dbFactory override → factory called once
//      with the URL; app.db is that handle; closeDb is invoked on
//      app.close().

import assert from "node:assert/strict";

import { buildServer } from "../src/server.ts";

function fakeHandle() {
  let ended = 0;
  return {
    handle: {
      client: {
        end: async () => {
          ended += 1;
        },
      },
      db: {},
    },
    endCount: () => ended,
  };
}

// Test 1: no env, no inject.
{
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const app = await buildServer({ logger: false });
    assert.equal(app.db, null);
    await app.close();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

// Test 2: injected handle is used and NOT closed by the server.
{
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const f = fakeHandle();
    const app = await buildServer({ logger: false, db: f.handle });
    assert.equal(app.db, f.handle);
    await app.close();
    assert.equal(f.endCount(), 0, "caller-owned handle must not be closed");
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

// Test 3: DATABASE_URL drives factory; server owns + closes.
{
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test-server-db/example";
  try {
    const f = fakeHandle();
    const factoryCalls = [];
    const factory = (cs) => {
      factoryCalls.push(cs);
      return f.handle;
    };
    const app = await buildServer({ logger: false, dbFactory: factory });
    assert.deepEqual(factoryCalls, ["postgres://test-server-db/example"]);
    assert.equal(app.db, f.handle);
    await app.close();
    assert.equal(f.endCount(), 1, "owned handle must be closed exactly once");
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
}

console.log("serverDb.test.mjs OK");
