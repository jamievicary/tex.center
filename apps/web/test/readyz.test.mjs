// Unit test for `probeReady`. Covers every branch of the readiness
// helper with stubbed `probeDb` impls; the route module itself is
// composition-only (driven by the static parser test).

import assert from "node:assert/strict";

import { probeReady, READYZ_PROTOCOL } from "../src/lib/server/readyz.ts";

// 1. No DB handle configured → state "absent", ok true.
{
  const result = await probeReady({ probeDb: () => null });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, READYZ_PROTOCOL);
  assert.deepEqual(result.db, { state: "absent" });
}

// 2. Probe resolves → state "up", ok true.
{
  let called = 0;
  const result = await probeReady({
    probeDb: () => {
      called++;
      return Promise.resolve();
    },
  });
  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.db, { state: "up" });
}

// 3. Probe rejects with Error → state "down", error message preserved, ok false.
{
  const result = await probeReady({
    probeDb: () => Promise.reject(new Error("connection refused")),
  });
  assert.equal(result.ok, false);
  assert.equal(result.db.state, "down");
  assert.equal(result.db.error, "connection refused");
}

// 4. Probe rejects with non-Error → stringified, ok false.
{
  const result = await probeReady({
    probeDb: () => Promise.reject("plain string oops"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.db.state, "down");
  assert.equal(result.db.error, "plain string oops");
}

console.log("readyz.test.mjs OK");
