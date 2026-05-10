// PKCE (RFC 7636) primitives for the Google OAuth Authorization
// Code flow. Two pieces:
//
//   - generatePkce() returns a fresh {verifier, challenge} pair.
//     The verifier is 43 chars of base64url(randomBytes(32)) — at
//     the lower end of the spec's 43–128 range, which keeps the
//     redirect URL short while still giving 256 bits of entropy.
//     base64url's alphabet ([A-Za-z0-9_-]) is a subset of the
//     verifier alphabet RFC 7636 §4.1 allows.
//
//   - computeChallenge(verifier) is the deterministic S256
//     transform: base64url(SHA256(verifier)). Useful on the
//     server side (compute-and-compare) and for tests.
//
// We only support method=S256. Google does too; "plain" is
// banned by spec for confidential clients and we have no reason
// to ever emit it.

import { createHash, randomBytes } from "node:crypto";

import { b64uEncode } from "./b64u.js";

export interface PkcePair {
  /** The high-entropy code_verifier sent on the token-exchange request. */
  readonly verifier: string;
  /** code_challenge = base64url(SHA256(verifier)), method=S256. */
  readonly challenge: string;
}

/** RFC 7636 §4.1 verifier alphabet: ALPHA / DIGIT / "-" / "." / "_" / "~". */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/u;

export function generatePkce(): PkcePair {
  const verifier = b64uEncode(randomBytes(32));
  return { verifier, challenge: computeChallenge(verifier) };
}

export function computeChallenge(verifier: string): string {
  if (!isValidVerifier(verifier)) {
    throw new Error("computeChallenge: verifier does not match RFC 7636 §4.1");
  }
  return b64uEncode(createHash("sha256").update(verifier, "utf8").digest());
}

export function isValidVerifier(s: unknown): s is string {
  return typeof s === "string" && VERIFIER_RE.test(s);
}
