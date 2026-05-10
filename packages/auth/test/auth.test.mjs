// Unit tests for the auth leaf module: allowlist + signed session
// tokens. Pure logic, no I/O.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  isAllowedEmail,
  ALLOWED_EMAILS,
  signSessionToken,
  verifySessionToken,
} from "../src/index.ts";

// --- allowlist ----------------------------------------------------

assert.equal(ALLOWED_EMAILS.length, 1);
assert.equal(ALLOWED_EMAILS[0], "jamievicary@gmail.com");

assert.equal(isAllowedEmail("jamievicary@gmail.com"), true);
assert.equal(isAllowedEmail("JamieVicary@Gmail.com"), true); // case-insensitive
assert.equal(isAllowedEmail("  jamievicary@gmail.com  "), true); // trimmed
assert.equal(isAllowedEmail("someone-else@gmail.com"), false);
assert.equal(isAllowedEmail(""), false);
assert.equal(isAllowedEmail(null), false);
assert.equal(isAllowedEmail(undefined), false);
// JS-only escape hatch: a non-string sneaks past TS into runtime.
assert.equal(isAllowedEmail(/** @type {any} */ (42)), false);

// --- session tokens: round-trip ----------------------------------

const key = randomBytes(32);
const otherKey = randomBytes(32);
const sid = randomUUID();
const now = 1_700_000_000; // arbitrary stable epoch
const exp = now + 3600;

const token = signSessionToken({ sid, exp }, key);

// Token shape is `<payload>.<sig>`, both base64url, no padding.
assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const ok = verifySessionToken(token, key, now);
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.payload.sid, sid);
  assert.equal(ok.payload.exp, exp);
}

// --- session tokens: rejections ----------------------------------

// Wrong key.
{
  const r = verifySessionToken(token, otherKey, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Expired (exactly at exp counts as expired — clock skew is the
// caller's problem, but `now >= exp` is not "ok").
{
  const r = verifySessionToken(token, key, exp);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "expired");
}
{
  const r = verifySessionToken(token, key, exp + 1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "expired");
}

// Tampered payload — flip a byte after signing.
{
  const [payload, sig] = token.split(".");
  // Replace first char with a different valid base64url char.
  const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
  const tampered = `${flipped}.${sig}`;
  const r = verifySessionToken(tampered, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Tampered signature.
{
  const [payload, sig] = token.split(".");
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  const tampered = `${payload}.${flipped}`;
  const r = verifySessionToken(tampered, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-signature");
}

// Malformed: no dot, multiple dots, empty halves.
for (const bad of ["nodothere", "a.b.c", ".sig", "payload."]) {
  const r = verifySessionToken(bad, key, now);
  assert.equal(r.ok, false, `expected reject for "${bad}"`);
  if (!r.ok) assert.equal(r.reason, "malformed");
}

// Non-base64url signature character → malformed (decode fails).
{
  const [payload] = token.split(".");
  const r = verifySessionToken(`${payload}.!!!`, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "malformed");
}

// Bad payload: valid signature on a non-JSON / wrong-shape payload.
// Sign garbage with the real key so we exercise the post-signature
// JSON/shape branch.
{
  const garbageB64u = Buffer.from("not json", "utf8")
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  // Re-sign so signature passes; we can't call internal hmac, so
  // we use a tiny helper inline.
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", key)
    .update(garbageB64u, "utf8")
    .digest()
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  const r = verifySessionToken(`${garbageB64u}.${sig}`, key, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-payload");
}

// --- sign-time validation ----------------------------------------

assert.throws(() => signSessionToken({ sid, exp }, new Uint8Array(0)), /key/);
assert.throws(
  () => signSessionToken({ sid: "", exp }, key),
  /sid/,
);
assert.throws(
  () => signSessionToken({ sid, exp: 1.5 }, key),
  /exp/,
);

console.log("packages/auth: all assertions passed");
