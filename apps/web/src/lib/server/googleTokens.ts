// Concrete I/O for `/auth/google/callback`:
//
//   - `exchangeCodeForTokens`: POSTs to Google's token endpoint
//     with `grant_type=authorization_code`, the auth code, our
//     redirect URI, client id+secret, and the PKCE verifier.
//   - `verifyGoogleIdToken`: fetches Google's JWKS (cached by
//     `jose`'s `createRemoteJWKSet`) and verifies the ID token's
//     RS256 signature, issuer, and audience, then surfaces a few
//     claims the resolver needs.
//
// Both are AsyncFunctions matching the injectable signatures on
// `oauthCallback.ts`. They are not pure (network I/O); their
// callers in tests pass stubs instead.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";

import type {
  ExchangeCodeFn,
  VerifiedIdToken,
  VerifyIdTokenFn,
} from "./oauthCallback.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

// Google's signers and our verifier can drift by a few seconds.
// Without tolerance, a token whose `exp` is just past our clock
// fails with `"exp" claim timestamp check failed`. 60s mirrors
// Google's own client libraries' default.
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export interface ExchangeCodeForTokensConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Override for tests; defaults to Google's production token endpoint. */
  readonly tokenUrl?: string;
  /** Override for tests. */
  readonly fetchFn?: typeof fetch;
}

export function makeExchangeCodeForTokens(
  config: ExchangeCodeForTokensConfig,
): ExchangeCodeFn {
  const fetchFn = config.fetchFn ?? fetch;
  const url = config.tokenUrl ?? TOKEN_URL;
  return async ({ code, verifier }) => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    });
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Google token endpoint ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { id_token?: unknown };
    if (typeof json.id_token !== "string" || json.id_token === "") {
      throw new Error("Google token response missing id_token");
    }
    return { idToken: json.id_token };
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return "<no body>";
  }
}

export interface VerifyGoogleIdTokenConfig {
  /** Override Google's JWKS endpoint (tests). */
  readonly jwksUrl?: string;
  /** Tolerance for `iat`/`exp` checks. Defaults to 60 seconds. */
  readonly clockToleranceSeconds?: number;
  /**
   * Inject a JWKS resolver or static key (tests). When provided,
   * `jwksUrl` is ignored and no remote fetcher is created.
   */
  readonly keyInput?: KeyLike | Uint8Array | JWTVerifyGetKey;
}

export function makeVerifyGoogleIdToken(
  config: VerifyGoogleIdTokenConfig = {},
): VerifyIdTokenFn {
  const clockTolerance =
    config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const keyInput =
    config.keyInput ??
    createRemoteJWKSet(new URL(config.jwksUrl ?? JWKS_URL));
  return async ({ idToken, audience }) => {
    const options = {
      audience,
      issuer: Array.from(ISSUERS),
      algorithms: ["RS256"],
      clockTolerance,
    };
    const { payload } =
      typeof keyInput === "function"
        ? await jwtVerify(idToken, keyInput, options)
        : await jwtVerify(idToken, keyInput, options);
    return claimsFromPayload(payload);
  };
}

export const verifyGoogleIdToken: VerifyIdTokenFn = makeVerifyGoogleIdToken();

function claimsFromPayload(p: JWTPayload): VerifiedIdToken {
  const sub = typeof p.sub === "string" ? p.sub : "";
  if (sub === "") {
    throw new Error("ID token missing sub claim");
  }
  const email = typeof p.email === "string" ? p.email : null;
  const emailVerified =
    typeof (p as { email_verified?: unknown }).email_verified === "boolean"
      ? ((p as { email_verified: boolean }).email_verified)
      : false;
  const name = typeof (p as { name?: unknown }).name === "string"
    ? ((p as { name: string }).name)
    : null;
  return { sub, email, emailVerified, name };
}
