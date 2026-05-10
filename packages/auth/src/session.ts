// HMAC-signed session tokens.
//
// A session token is `<payloadB64u>.<sigB64u>` (see `signed.ts`)
// where the JSON payload is `{ sid, exp }`. `sid` is an opaque
// server-side row id; `exp` is unix-seconds. Verification checks
// the signature in constant time, then expiry against a caller-
// supplied `nowSeconds` (tests stay deterministic; prod caller can
// stub time).
//
// Nothing in the payload is sensitive on its own — the server-side
// row is the source of truth, revocable per-user. The signature
// guarantees the cookie was minted by us; the expiry caps replay.

import { signJsonString, verifySignedJson } from "./signed.js";

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
  if (typeof payload.sid !== "string" || payload.sid.length === 0) {
    throw new Error("signSessionToken: payload.sid must be a non-empty string");
  }
  if (!Number.isFinite(payload.exp) || !Number.isInteger(payload.exp)) {
    throw new Error("signSessionToken: payload.exp must be an integer");
  }
  const json = JSON.stringify({ sid: payload.sid, exp: payload.exp });
  return signJsonString(json, key);
}

export function verifySessionToken(
  token: string,
  key: Uint8Array,
  nowSeconds: number,
): VerifyResult {
  const r = verifySignedJson(token, key);
  if (!r.ok) return { ok: false, reason: r.reason };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.payloadJson);
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
