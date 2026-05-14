// Pure orchestrator for `POST /auth/google/test-callback`.
//
// Test-only finaliser route used by M8.pw.3: drives the post-token-verify
// half of the OAuth callback (JWKS verify → allowlist → DB upsert →
// signed session cookie) from a real Google ID token obtained out of
// band (refresh-token grant against a separate, pre-consented OAuth
// client). The PKCE/code-exchange leg is skipped.
//
// Auth envelope:
//
//   - Route 404s entirely unless `TEST_OAUTH_BYPASS_KEY` is set on the
//     server (wiring layer's job).
//   - Caller signs the literal request body with HMAC-SHA256(key) and
//     supplies the digest (hex, lowercase) in `X-Test-Bypass`.
//     Comparison is `timingSafeEqual`.
//   - The cryptographic ID-token check (`verifyIdToken`) still runs.
//     Bypassing it would defeat the very regression we're guarding —
//     iter 129 was a JWKS module-not-found.
//
// A successful attack still requires the bypass key (a Fly secret) AND
// a Google ID token signed for our OAuth audience whose claims pass
// the allowlist — comparable to obtaining the OAuth client secret +
// a real user login. Acceptable for the single-user MVP.
//
// Returns the same `GoogleCallbackResolution` shape as
// `resolveGoogleCallback` so the route's `toResponse` helper works
// unchanged.
//
// All I/O is injected; the route module wires real implementations.

import { createHmac, timingSafeEqual } from "node:crypto";

import { errorMessage } from "../errors.js";

import type {
  GoogleCallbackResolution,
  VerifiedIdToken,
  VerifyIdTokenFn,
} from "./oauthCallback.js";

export type FinalizeForTestFn = (
  claims: VerifiedIdToken,
) => Promise<GoogleCallbackResolution>;

export interface ResolveTestCallbackInput {
  /** Raw request body bytes — what the HMAC was computed over. */
  readonly bodyText: string;
  /** Value of the `X-Test-Bypass` header, or `null` if absent. */
  readonly bypassHeader: string | null;
  /** HMAC key bytes (server env `TEST_OAUTH_BYPASS_KEY` decoded). */
  readonly bypassKey: Uint8Array;
  /** OAuth client_id; ID-token audience. */
  readonly audience: string;
  readonly verifyIdToken: VerifyIdTokenFn;
  readonly finalize: FinalizeForTestFn;
}

export async function resolveTestCallback(
  input: ResolveTestCallbackInput,
): Promise<GoogleCallbackResolution> {
  if (input.bypassKey.byteLength === 0) {
    // Defensive: the route should already have 404'd. Treat an empty
    // key as misconfiguration rather than silently accepting anything.
    return errorWith(500, "TEST_OAUTH_BYPASS_KEY is empty.");
  }
  if (input.bypassHeader === null || input.bypassHeader === "") {
    return errorWith(401, "Missing X-Test-Bypass header.");
  }

  if (!/^[0-9a-f]+$/u.test(input.bypassHeader)) {
    return errorWith(401, "Malformed X-Test-Bypass header.");
  }
  const provided = Buffer.from(input.bypassHeader, "hex");
  const expected = hmac(input.bypassKey, input.bodyText);
  if (
    provided.byteLength !== expected.byteLength ||
    !timingSafeEqual(provided, expected)
  ) {
    return errorWith(401, "Invalid X-Test-Bypass signature.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return errorWith(400, "Body is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { idToken?: unknown }).idToken !== "string" ||
    (parsed as { idToken: string }).idToken === ""
  ) {
    return errorWith(400, "Body must be {idToken: string}.");
  }
  const idToken = (parsed as { idToken: string }).idToken;

  let claims: VerifiedIdToken;
  try {
    claims = await input.verifyIdToken({ idToken, audience: input.audience });
  } catch (err) {
    return errorWith(
      401,
      `ID token verification failed: ${errorMessage(err)}`,
    );
  }

  return input.finalize(claims);
}

function errorWith(status: number, body: string): GoogleCallbackResolution {
  return { kind: "error", status, body, setCookies: [] };
}

function hmac(key: Uint8Array, data: string): Buffer {
  const h = createHmac("sha256", key);
  h.update(data, "utf8");
  return h.digest();
}
