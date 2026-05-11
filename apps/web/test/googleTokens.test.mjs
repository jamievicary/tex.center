// Unit test for `makeVerifyGoogleIdToken`.
//
// Signs ID tokens locally with an RS256 keypair and verifies them
// through the production verifier with the test keypair injected as
// `keyInput`. The point of the test is to lock in `clockTolerance`
// behaviour: a token whose `iat` is a few seconds ahead of our clock
// must still verify (real Google signers drift), but one that is
// well beyond the tolerance must not.

import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";

import { makeVerifyGoogleIdToken } from "../src/lib/server/googleTokens.ts";

const AUDIENCE = "TEST_CLIENT.apps.googleusercontent.com";
const ISSUER = "https://accounts.google.com";

const { publicKey, privateKey } = await generateKeyPair("RS256");

async function signToken(claims) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
}

async function tokenWithTimes({ iat, exp, overrides = {} }) {
  return signToken({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "1234567890",
    email: "user@example.com",
    email_verified: true,
    name: "Test User",
    iat,
    exp,
    ...overrides,
  });
}

// 1. Well-formed token verifies and surfaces claims.
{
  const verify = makeVerifyGoogleIdToken({ keyInput: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await tokenWithTimes({ iat: now - 5, exp: now + 3600 });
  const claims = await verify({ idToken, audience: AUDIENCE });
  assert.equal(claims.sub, "1234567890");
  assert.equal(claims.email, "user@example.com");
  assert.equal(claims.emailVerified, true);
  assert.equal(claims.name, "Test User");
}

// 2. exp slightly in the past (within the default 60s tolerance)
//    still verifies. Google's signer clock can be ahead of ours, so
//    a token whose `exp` is a few seconds in the past from our view
//    is still live in real terms. Without tolerance, jose rejects
//    this with `"exp" claim timestamp check failed`.
{
  const verify = makeVerifyGoogleIdToken({ keyInput: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await tokenWithTimes({ iat: now - 3600, exp: now - 30 });
  const claims = await verify({ idToken, audience: AUDIENCE });
  assert.equal(claims.sub, "1234567890");
}

// 3. exp past beyond the configured tolerance fails.
{
  const verify = makeVerifyGoogleIdToken({
    keyInput: publicKey,
    clockToleranceSeconds: 10,
  });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await tokenWithTimes({ iat: now - 3600, exp: now - 300 });
  await assert.rejects(() => verify({ idToken, audience: AUDIENCE }));
}

// 4. With tolerance explicitly set to zero, even a 30s-expired token
//    fails — confirms it is the tolerance, not some other behaviour,
//    that lets test 2 through.
{
  const verify = makeVerifyGoogleIdToken({
    keyInput: publicKey,
    clockToleranceSeconds: 0,
  });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await tokenWithTimes({ iat: now - 3600, exp: now - 30 });
  await assert.rejects(() => verify({ idToken, audience: AUDIENCE }));
}

// 6. Wrong audience fails regardless of tolerance.
{
  const verify = makeVerifyGoogleIdToken({ keyInput: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await tokenWithTimes({ iat: now, exp: now + 3600 });
  await assert.rejects(() =>
    verify({ idToken, audience: "OTHER_CLIENT.apps.googleusercontent.com" }),
  );
}

// 7. Wrong issuer fails.
{
  const verify = makeVerifyGoogleIdToken({ keyInput: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signToken({
    iss: "https://evil.example.com",
    aud: AUDIENCE,
    sub: "1234567890",
    email_verified: true,
    iat: now,
    exp: now + 3600,
  });
  await assert.rejects(() => verify({ idToken, audience: AUDIENCE }));
}

// 8. Missing sub claim throws via `claimsFromPayload`.
{
  const verify = makeVerifyGoogleIdToken({ keyInput: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signToken({
    iss: ISSUER,
    aud: AUDIENCE,
    email_verified: true,
    iat: now,
    exp: now + 3600,
  });
  await assert.rejects(() => verify({ idToken, audience: AUDIENCE }), {
    message: /missing sub/,
  });
}

console.log("googleTokens tests passed");
