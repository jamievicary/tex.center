// Tests for the signed OAuth state cookie. Round-trip + every
// rejection branch.

import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";

import {
  generatePkce,
  signStateCookie,
  verifyStateCookie,
} from "../src/index.ts";

const key = randomBytes(32);
const otherKey = randomBytes(32);
const now = 1_700_000_000;
const exp = now + 600;

const { verifier } = generatePkce();
const state = randomBytes(32).toString("base64url");

// --- round trip --------------------------------------------------

const token = signStateCookie({ state, verifier, exp }, key);
assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const ok = verifyStateCookie(token, key, now);
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.payload.state, state);
  assert.equal(ok.payload.verifier, verifier);
  assert.equal(ok.payload.exp, exp);
}

// --- rejections --------------------------------------------------

// Wrong key.
{
  const r = verifyStateCookie(token, otherKey, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Expired.
{
  const r = verifyStateCookie(token, key, exp);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "expired");
}

// Tampered payload.
{
  const [p, s] = token.split(".");
  const flipped = (p[0] === "A" ? "B" : "A") + p.slice(1);
  const r = verifyStateCookie(`${flipped}.${s}`, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Tampered signature.
{
  const [p, s] = token.split(".");
  const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
  const r = verifyStateCookie(`${p}.${flipped}`, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Malformed shapes.
for (const bad of ["nodothere", "a.b.c", ".sig", "payload.", "!!!.!!!"]) {
  const r = verifyStateCookie(bad, key, now);
  assert.equal(r.ok, false, `expected reject for "${bad}"`);
}

// Non-base64url signature char.
{
  const [p] = token.split(".");
  const r = verifyStateCookie(`${p}.!!!`, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "malformed");
}

// Valid signature, garbage payload.
{
  function b64u(s) {
    return Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/=+$/u, "")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
  }
  function sign(p) {
    return createHmac("sha256", key)
      .update(p, "utf8")
      .digest()
      .toString("base64")
      .replace(/=+$/u, "")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
  }

  // Not JSON.
  {
    const p = b64u("not json");
    const r = verifyStateCookie(`${p}.${sign(p)}`, key, now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad-payload");
  }

  // JSON but wrong shape.
  {
    const p = b64u(JSON.stringify({ state, verifier }));
    const r = verifyStateCookie(`${p}.${sign(p)}`, key, now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad-payload");
  }

  // JSON, right keys, but state is empty (fails STATE_RE).
  {
    const p = b64u(JSON.stringify({ state: "", verifier, exp }));
    const r = verifyStateCookie(`${p}.${sign(p)}`, key, now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad-payload");
  }

  // JSON, right keys, but verifier is too short.
  {
    const p = b64u(JSON.stringify({ state, verifier: "abc", exp }));
    const r = verifyStateCookie(`${p}.${sign(p)}`, key, now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad-payload");
  }
}

// --- sign-time validation ----------------------------------------

assert.throws(() => signStateCookie({ state: "", verifier, exp }, key), /state/);
assert.throws(
  () => signStateCookie({ state, verifier: "tooshort", exp }, key),
  /verifier/,
);
assert.throws(
  () => signStateCookie({ state, verifier, exp: 1.5 }, key),
  /exp/,
);
assert.throws(
  () => signStateCookie({ state, verifier, exp }, new Uint8Array(0)),
  /key/,
);

console.log("packages/auth state-cookie: all assertions passed");
