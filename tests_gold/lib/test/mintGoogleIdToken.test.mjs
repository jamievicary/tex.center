// Unit test for `mintGoogleIdToken`. Injects a stub `fetch` so no
// network I/O. Covers: happy path (form encoding + id_token
// surfaced), upstream non-2xx → throw, 2xx without id_token →
// throw, empty inputs rejected before fetch.

import assert from "node:assert/strict";

import { mintGoogleIdToken } from "../src/mintGoogleIdToken.ts";

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler({ url: String(url), init });
  };
  return { fn, calls };
}

function jsonRes(status, body) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textRes(status, text) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => text,
  };
}

// Happy path.
{
  const { fn, calls } = makeFetch(() =>
    jsonRes(200, { id_token: "eyJ.real.jwt", access_token: "ya29..." }),
  );
  const out = await mintGoogleIdToken({
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "1//rtok",
    fetchFn: fn,
  });
  assert.equal(out.idToken, "eyJ.real.jwt");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(body.get("client_secret"), "csecret");
  assert.equal(body.get("refresh_token"), "1//rtok");
}

// tokenUrl override.
{
  const { fn, calls } = makeFetch(() => jsonRes(200, { id_token: "tok" }));
  await mintGoogleIdToken({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    tokenUrl: "https://example.test/oauth/token",
    fetchFn: fn,
  });
  assert.equal(calls[0].url, "https://example.test/oauth/token");
}

// Non-2xx → throw with status + body.
{
  const { fn } = makeFetch(() => textRes(400, "bad_request: bad grant"));
  await assert.rejects(
    () =>
      mintGoogleIdToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        fetchFn: fn,
      }),
    /Google token endpoint 400:.*bad_request/,
  );
}

// 2xx but missing id_token → throw.
{
  const { fn } = makeFetch(() => jsonRes(200, { access_token: "x" }));
  await assert.rejects(
    () =>
      mintGoogleIdToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        fetchFn: fn,
      }),
    /missing id_token/,
  );
}

// Empty-string inputs rejected before fetch (no calls made).
{
  for (const field of ["clientId", "clientSecret", "refreshToken"]) {
    const { fn, calls } = makeFetch(() => jsonRes(200, { id_token: "x" }));
    const input = { clientId: "c", clientSecret: "s", refreshToken: "r", fetchFn: fn };
    input[field] = "";
    await assert.rejects(() => mintGoogleIdToken(input), new RegExp(field));
    assert.equal(calls.length, 0);
  }
}

console.log("mintGoogleIdToken.test.mjs: ok");
