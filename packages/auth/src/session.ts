// HMAC-signed session tokens.
//
// A session token is `<payloadB64u>.<sigB64u>` where:
//
//   payload = JSON.stringify({ sid: <uuid>, exp: <unix-seconds> })
//   sig     = HMAC_SHA256(key, payloadB64u)
//
// Both halves are base64url, no padding. The payload is *not*
// encrypted — sid is opaque (a server-side row id), exp is a
// number; nothing here is sensitive on its own. The signature
// guarantees the cookie was minted by us, the expiry caps replay,
// and the server-side session row is the actual source of truth
// (revocable, per-user). Verification checks the signature in
// constant time, then the expiry against a caller-supplied
// `nowSeconds` (so tests are deterministic and the prod caller
// can stub time if needed).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  /** Opaque server-side session id (uuid). */
  readonly sid: string;
  /** Unix epoch seconds at which the token stops being valid. */
  readonly exp: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: VerifyFailure };

export type VerifyFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "bad-payload";

export function signSessionToken(
  payload: SessionPayload,
  key: Uint8Array,
): string {
  if (key.byteLength === 0) {
    throw new Error("signSessionToken: key must be non-empty");
  }
  if (typeof payload.sid !== "string" || payload.sid.length === 0) {
    throw new Error("signSessionToken: payload.sid must be a non-empty string");
  }
  if (!Number.isFinite(payload.exp) || !Number.isInteger(payload.exp)) {
    throw new Error("signSessionToken: payload.exp must be an integer");
  }
  const json = JSON.stringify({ sid: payload.sid, exp: payload.exp });
  const payloadB64u = b64uEncode(Buffer.from(json, "utf8"));
  const sig = hmac(key, payloadB64u);
  return `${payloadB64u}.${b64uEncode(sig)}`;
}

export function verifySessionToken(
  token: string,
  key: Uint8Array,
  nowSeconds: number,
): VerifyResult {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { sid?: unknown }).sid !== "string" ||
    typeof (parsed as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  const sid = (parsed as { sid: string }).sid;
  const exp = (parsed as { exp: number }).exp;
  if (sid.length === 0 || !Number.isInteger(exp)) {
    return { ok: false, reason: "bad-payload" };
  }
  if (nowSeconds >= exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: { sid, exp } };
}

function hmac(key: Uint8Array, data: string): Buffer {
  const h = createHmac("sha256", key);
  h.update(data, "utf8");
  return h.digest();
}

function b64uEncode(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function b64uDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) {
    throw new Error("invalid base64url");
  }
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/gu, "+").replace(/_/gu, "/") + pad, "base64");
}
