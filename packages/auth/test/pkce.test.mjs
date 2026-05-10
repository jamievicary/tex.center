// Unit tests for PKCE primitives (RFC 7636, S256 method).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  generatePkce,
  computeChallenge,
  isValidVerifier,
} from "../src/index.ts";

// --- generatePkce -------------------------------------------------

const a = generatePkce();
const b = generatePkce();

// 32 random bytes → base64url length 43, no padding.
assert.equal(a.verifier.length, 43);
assert.match(a.verifier, /^[A-Za-z0-9_-]+$/u);
assert.ok(isValidVerifier(a.verifier));

// Challenge is base64url(SHA256(verifier)) — 43 chars too.
assert.equal(a.challenge.length, 43);
assert.match(a.challenge, /^[A-Za-z0-9_-]+$/u);

// Each call yields a fresh pair.
assert.notEqual(a.verifier, b.verifier);
assert.notEqual(a.challenge, b.challenge);

// --- computeChallenge: deterministic + matches manual S256 -------

assert.equal(computeChallenge(a.verifier), a.challenge);

{
  // RFC 7636 Appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(computeChallenge(verifier), expected);
}

// Manual SHA-256 cross-check on a freshly generated verifier.
{
  const expected = createHash("sha256")
    .update(b.verifier, "utf8")
    .digest()
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  assert.equal(computeChallenge(b.verifier), expected);
}

// --- isValidVerifier ---------------------------------------------

assert.equal(isValidVerifier("a".repeat(43)), true);
assert.equal(isValidVerifier("a".repeat(128)), true);
assert.equal(isValidVerifier("-._~ABCabc012".padEnd(43, "x")), true);

assert.equal(isValidVerifier("a".repeat(42)), false); // too short
assert.equal(isValidVerifier("a".repeat(129)), false); // too long
assert.equal(isValidVerifier("!".repeat(43)), false); // bad char
assert.equal(isValidVerifier("a".repeat(43) + "+"), false); // base64 char outside RFC alphabet
assert.equal(isValidVerifier(""), false);
assert.equal(isValidVerifier(null), false);
assert.equal(isValidVerifier(undefined), false);
assert.equal(isValidVerifier(/** @type {any} */ (42)), false);

// --- computeChallenge: input validation --------------------------

assert.throws(() => computeChallenge("too-short"), /RFC 7636/);
assert.throws(() => computeChallenge("!".repeat(43)), /RFC 7636/);
assert.throws(
  () => computeChallenge(/** @type {any} */ (null)),
  /RFC 7636/,
);

console.log("packages/auth pkce: all assertions passed");
