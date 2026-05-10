// Signed OAuth state cookie.
//
// `/auth/google/start` mints this cookie before redirecting to
// Google; `/auth/google/callback` verifies it and uses `verifier`
// for the PKCE code-exchange. The payload is
//
//   { state, verifier, exp }
//
// where `state` is the opaque value echoed back by Google (CSRF
// check), `verifier` is the PKCE `code_verifier` we kept off the
// wire, and `exp` caps the lifetime of an unanswered redirect.
// Built on `signed.ts` — same HMAC primitive as `session.ts`.

import { isValidVerifier } from "./pkce.js";
import { signJsonString, verifySignedJson } from "./signed.js";

export interface StatePayload {
  /** Opaque value sent to Google as `&state=…` and echoed back. */
  readonly state: string;
  /** PKCE code_verifier; sent on the token-exchange request. */
  readonly verifier: string;
  /** Unix epoch seconds at which the cookie stops being valid. */
  readonly exp: number;
}

export type StateVerifyResult =
  | { readonly ok: true; readonly payload: StatePayload }
  | { readonly ok: false; readonly reason: StateVerifyFailure };

export type StateVerifyFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "bad-payload";

/** base64url, non-empty (we generate `state` that way). */
const STATE_RE = /^[A-Za-z0-9_-]+$/u;

export function signStateCookie(
  payload: StatePayload,
  key: Uint8Array,
): string {
  if (!STATE_RE.test(payload.state)) {
    throw new Error("signStateCookie: state must be non-empty base64url");
  }
  if (!isValidVerifier(payload.verifier)) {
    throw new Error("signStateCookie: verifier does not match RFC 7636 §4.1");
  }
  if (!Number.isFinite(payload.exp) || !Number.isInteger(payload.exp)) {
    throw new Error("signStateCookie: exp must be an integer");
  }
  const json = JSON.stringify({
    state: payload.state,
    verifier: payload.verifier,
    exp: payload.exp,
  });
  return signJsonString(json, key);
}

export function verifyStateCookie(
  token: string,
  key: Uint8Array,
  nowSeconds: number,
): StateVerifyResult {
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
    typeof (parsed as { state?: unknown }).state !== "string" ||
    typeof (parsed as { verifier?: unknown }).verifier !== "string" ||
    typeof (parsed as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  const { state, verifier, exp } = parsed as StatePayload;
  if (
    !STATE_RE.test(state) ||
    !isValidVerifier(verifier) ||
    !Number.isInteger(exp)
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  if (nowSeconds >= exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: { state, verifier, exp } };
}
