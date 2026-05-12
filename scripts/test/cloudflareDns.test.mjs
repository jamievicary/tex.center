// Unit tests for the Cloudflare DNS reconciler. Pure-logic for
// `reconcileRecords` and `buildDesired`; stub-fetch tests for the
// I/O wrappers. No real network access.

import assert from "node:assert/strict";

import {
  reconcileRecords,
  buildDesired,
  buildHeaders,
  fetchZoneId,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  parseTokenFile,
} from "../cloudflare-dns.mjs";

// --- parseTokenFile -----------------------------------------------

// Raw bearer string round-trips, with surrounding whitespace trimmed.
assert.equal(parseTokenFile("abc123"), "abc123");
assert.equal(parseTokenFile("  abc123\n"), "abc123");

// JSON object with a .token field unwraps to the token.
assert.equal(
  parseTokenFile('{"token":"abc123","zone":"tex.center","zone_id":"z1"}'),
  "abc123",
);
assert.equal(
  parseTokenFile('\n  {"token": "  abc123  "}\n'),
  "abc123",
);

// Empty body rejected.
assert.throws(() => parseTokenFile(""), /empty token file/);
assert.throws(() => parseTokenFile("   \n  "), /empty token file/);

// JSON-shaped but malformed → "looks like JSON but failed to parse".
assert.throws(() => parseTokenFile("{not json"), /failed to parse/);

// JSON without a usable `token` field → explicit error.
assert.throws(() => parseTokenFile('{"zone":"tex.center"}'), /missing a non-empty `token` field/);
assert.throws(() => parseTokenFile('{"token":""}'), /missing a non-empty `token` field/);
assert.throws(() => parseTokenFile('{"token":123}'), /missing a non-empty `token` field/);

// --- buildDesired -------------------------------------------------

{
  const d = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  assert.equal(d.length, 1);
  assert.deepEqual(d[0], {
    type: "A",
    name: "tex.center",
    content: "1.2.3.4",
    ttl: 1,
    proxied: false,
  });
}
{
  const d = buildDesired("tex.center", { ipv4: "1.2.3.4", ipv6: "::1" });
  assert.equal(d.length, 2);
  assert.equal(d[0].type, "A");
  assert.equal(d[1].type, "AAAA");
  assert.equal(d[1].content, "::1");
}
{
  const d = buildDesired("tex.center", {
    ipv4: "1.2.3.4",
    acmeName: "_acme-challenge.tex.center",
    acmeValue: "abc",
  });
  assert.equal(d.length, 2);
  assert.equal(d[1].type, "TXT");
  assert.equal(d[1].name, "_acme-challenge.tex.center");
  assert.equal(d[1].content, "abc");
}
{
  // acmeName without value is incomplete → no TXT.
  const d = buildDesired("tex.center", { ipv4: "1.2.3.4", acmeName: "x" });
  assert.equal(d.length, 1);
}

// --- reconcileRecords: empty existing → all creates ---------------

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4", ipv6: "::1" });
  const ops = reconcileRecords({ existing: [], desired });
  assert.equal(ops.toCreate.length, 2);
  assert.equal(ops.toUpdate.length, 0);
  assert.equal(ops.toDelete.length, 0);
}

// --- reconcileRecords: exact match → no-op ------------------------

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    {
      id: "r1",
      type: "A",
      name: "tex.center",
      content: "1.2.3.4",
      ttl: 1,
      proxied: false,
    },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toCreate.length, 0);
  assert.equal(ops.toUpdate.length, 0);
  assert.equal(ops.toDelete.length, 0);
}

// --- reconcileRecords: content drift → update --------------------

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    { id: "r1", type: "A", name: "tex.center", content: "9.9.9.9", ttl: 1, proxied: false },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toCreate.length, 0);
  assert.equal(ops.toUpdate.length, 1);
  assert.equal(ops.toUpdate[0].id, "r1");
  assert.equal(ops.toUpdate[0].content, "1.2.3.4");
  assert.equal(ops.toDelete.length, 0);
}

// --- reconcileRecords: ttl drift → update -------------------------

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    { id: "r1", type: "A", name: "tex.center", content: "1.2.3.4", ttl: 300, proxied: false },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toUpdate.length, 1);
}

// --- reconcileRecords: proxied drift → update ---------------------

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    { id: "r1", type: "A", name: "tex.center", content: "1.2.3.4", ttl: 1, proxied: true },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toUpdate.length, 1);
}

// --- reconcileRecords: duplicate existing → collapse to one + del

{
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    { id: "r1", type: "A", name: "tex.center", content: "1.2.3.4", ttl: 1, proxied: false },
    { id: "r2", type: "A", name: "tex.center", content: "5.5.5.5", ttl: 1, proxied: false },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toCreate.length, 0);
  assert.equal(ops.toUpdate.length, 0);
  assert.equal(ops.toDelete.length, 1);
  assert.equal(ops.toDelete[0].id, "r2");
}

// --- reconcileRecords: unmanaged records left alone --------------

{
  // Desired only manages A@apex. Existing has MX and CNAME records
  // that aren't ours; we must never touch them.
  const desired = buildDesired("tex.center", { ipv4: "1.2.3.4" });
  const existing = [
    { id: "mx1", type: "MX", name: "tex.center", content: "mail.example.com", ttl: 1 },
    { id: "cn1", type: "CNAME", name: "www.tex.center", content: "tex.center", ttl: 1 },
  ];
  const ops = reconcileRecords({ existing, desired });
  assert.equal(ops.toCreate.length, 1);
  assert.equal(ops.toUpdate.length, 0);
  assert.equal(ops.toDelete.length, 0);
}

// --- buildHeaders -------------------------------------------------

{
  const h = buildHeaders("tok-abc");
  assert.equal(h.Authorization, "Bearer tok-abc");
  assert.equal(h["Content-Type"], "application/json");
}

// --- fetch wrappers with stub fetch ------------------------------

function makeFetch(handlers) {
  return async (url, init) => {
    for (const [match, respond] of handlers) {
      if (match(url, init)) {
        const body = respond(url, init);
        return {
          ok: body.ok ?? true,
          status: body.status ?? 200,
          json: async () => body.payload,
        };
      }
    }
    throw new Error(`no stub for ${init?.method ?? "GET"} ${url}`);
  };
}

// fetchZoneId — happy path
{
  const fetch = makeFetch([
    [
      (u) => u.endsWith("/zones?name=tex.center"),
      () => ({ payload: { success: true, result: [{ id: "z-1" }] } }),
    ],
  ]);
  const id = await fetchZoneId("t", "tex.center", { fetch });
  assert.equal(id, "z-1");
}

// fetchZoneId — zone not found
{
  const fetch = makeFetch([
    [(u) => u.includes("/zones?"), () => ({ payload: { success: true, result: [] } })],
  ]);
  await assert.rejects(() => fetchZoneId("t", "missing.example", { fetch }), /not found/);
}

// fetchZoneId — Cloudflare error
{
  const fetch = makeFetch([
    [
      (u) => u.includes("/zones?"),
      () => ({
        ok: false,
        status: 401,
        payload: { success: false, errors: [{ code: 10000, message: "bad auth" }] },
      }),
    ],
  ]);
  await assert.rejects(() => fetchZoneId("t", "tex.center", { fetch }), /Cloudflare API 401/);
}

// listRecords — sends Authorization header
{
  let seenInit;
  const fetch = makeFetch([
    [
      (u) => u.includes("/dns_records?per_page=100"),
      (_u, init) => {
        seenInit = init;
        return { payload: { success: true, result: [{ id: "r1", type: "A" }] } };
      },
    ],
  ]);
  const recs = await listRecords("tok", "z-1", { fetch });
  assert.equal(recs.length, 1);
  assert.equal(seenInit.headers.Authorization, "Bearer tok");
}

// createRecord — POST with body
{
  let seenInit, seenUrl;
  const fetch = makeFetch([
    [
      (u, init) => init?.method === "POST",
      (u, init) => {
        seenInit = init;
        seenUrl = u;
        return { payload: { success: true, result: { id: "new-1" } } };
      },
    ],
  ]);
  const r = { type: "A", name: "tex.center", content: "1.2.3.4", ttl: 1, proxied: false };
  const result = await createRecord("tok", "z-1", r, { fetch });
  assert.equal(result.id, "new-1");
  assert.equal(seenInit.method, "POST");
  assert.deepEqual(JSON.parse(seenInit.body), r);
  assert.ok(seenUrl.endsWith("/zones/z-1/dns_records"));
}

// updateRecord — PUT to /:id, id NOT in body
{
  let seenInit, seenUrl;
  const fetch = makeFetch([
    [
      (u, init) => init?.method === "PUT",
      (u, init) => {
        seenInit = init;
        seenUrl = u;
        return { payload: { success: true, result: { id: "r1" } } };
      },
    ],
  ]);
  const r = { id: "r1", type: "A", name: "tex.center", content: "1.2.3.4", ttl: 1, proxied: false };
  await updateRecord("tok", "z-1", r, { fetch });
  assert.equal(seenInit.method, "PUT");
  assert.ok(seenUrl.endsWith("/zones/z-1/dns_records/r1"));
  const sent = JSON.parse(seenInit.body);
  assert.equal(sent.id, undefined);
  assert.equal(sent.content, "1.2.3.4");
}

// deleteRecord — DELETE to /:id
{
  let seenInit, seenUrl;
  const fetch = makeFetch([
    [
      (u, init) => init?.method === "DELETE",
      (u, init) => {
        seenInit = init;
        seenUrl = u;
        return { payload: { success: true, result: { id: "r1" } } };
      },
    ],
  ]);
  await deleteRecord("tok", "z-1", "r1", { fetch });
  assert.equal(seenInit.method, "DELETE");
  assert.ok(seenUrl.endsWith("/zones/z-1/dns_records/r1"));
}

console.log("scripts/test/cloudflareDns.test.mjs: PASS");
