// Pure builder for the `/auth/google/start` redirect.
//
// Given Google OAuth config + a PKCE pair + a random `state` value
// + the cookie-signing key, returns the values the SvelteKit route
// handler needs to set on its Response:
//
//   - `location` — Google's authorize URL, ready for a 302.
//   - `stateCookie` — fully-formed Set-Cookie value (name=value;
//     attributes).
//
// Side-effect-free; the route handler does the actual I/O.

import { signStateCookie, type PkcePair } from "@tex-center/auth";

import { formatSetCookie } from "./cookies.js";

export interface GoogleAuthorizeRedirectInput {
  /** OAuth client_id from creds/google-oauth.json. */
  readonly clientId: string;
  /** Absolute redirect URI registered with Google. */
  readonly redirectUri: string;
  /** HMAC key for the state cookie. */
  readonly signingKey: Uint8Array;
  /** Fresh PKCE pair (verifier kept in the cookie, challenge in the URL). */
  readonly pkce: PkcePair;
  /** Opaque CSRF state value; echoed back by Google. */
  readonly state: string;
  /** Unix seconds at "now"; cookie exp = nowSeconds + stateTtlSeconds. */
  readonly nowSeconds: number;
  /** Cookie / `exp` lifetime, seconds. */
  readonly stateTtlSeconds: number;
  /** Whether to emit the `Secure` cookie attribute. */
  readonly secureCookie: boolean;
  /** Cookie name. */
  readonly cookieName: string;
}

export interface GoogleAuthorizeRedirect {
  readonly location: string;
  readonly stateCookie: string;
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function buildGoogleAuthorizeRedirect(
  input: GoogleAuthorizeRedirectInput,
): GoogleAuthorizeRedirect {
  const exp = input.nowSeconds + input.stateTtlSeconds;
  const token = signStateCookie(
    { state: input.state, verifier: input.pkce.verifier, exp },
    input.signingKey,
  );

  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email",
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    state: input.state,
    prompt: "select_account",
    access_type: "online",
  });

  return {
    location: `${AUTHORIZE_URL}?${params.toString()}`,
    stateCookie: formatSetCookie({
      name: input.cookieName,
      value: token,
      path: "/auth",
      maxAgeSeconds: input.stateTtlSeconds,
      secure: input.secureCookie,
    }),
  };
}
