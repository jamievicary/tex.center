// HMAC-SHA256 signed opaque payloads.
//
// A signed token is `<payloadB64u>.<sigB64u>` where:
//
//   sig = HMAC_SHA256(key, payloadB64u)
//
// Both halves are base64url, no padding. This module knows nothing
// about what's inside the payload — that's the caller's job (JSON
// shape, expiry, etc.). It only guarantees that whoever holds the
// key minted the bytes. Used both by session cookies (`session.ts`,
// `{sid, exp}`) and the OAuth state cookie (`state.ts`,
// `{state, verifier, exp}`).

import { createHmac, timingSafeEqual } from "node:crypto";

import { b64uDecode, b64uEncode } from "./b64u.js";

export type SignedVerifyFailure = "malformed" | "bad-signature";

export type SignedVerifyResult =
  | { readonly ok: true; readonly payloadJson: string }
  | { readonly ok: false; readonly reason: SignedVerifyFailure };

export function signJsonString(
  payloadJson: string,
  key: Uint8Array,
): string {
  if (key.byteLength === 0) {
    throw new Error("signJsonString: key must be non-empty");
  }
  const payloadB64u = b64uEncode(Buffer.from(payloadJson, "utf8"));
  const sig = hmac(key, payloadB64u);
  return `${payloadB64u}.${b64uEncode(sig)}`;
}

export function verifySignedJson(
  token: string,
  key: Uint8Array,
): SignedVerifyResult {
  if (typeof token !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  if (token.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64u = token.slice(0, dot);
  const sigB64u = token.slice(dot + 1);

  const expected = hmac(key, payloadB64u);
  let provided: Buffer;
  try {
    provided = b64uDecode(sigB64u);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.byteLength !== expected.byteLength) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payloadJson: string;
  try {
    payloadJson = b64uDecode(payloadB64u).toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, payloadJson };
}

function hmac(key: Uint8Array, data: string): Buffer {
  const h = createHmac("sha256", key);
  h.update(data, "utf8");
  return h.digest();
}
