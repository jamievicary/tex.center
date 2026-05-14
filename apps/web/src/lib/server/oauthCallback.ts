// Pure orchestrator for `/auth/google/callback`.
//
// All I/O (HTTP token exchange, JWKS ID-token verification, fresh
// session-id minting) is supplied by the caller. The result is a
// discriminated union the SvelteKit route hands straight back as a
// Response.
//
// Flow:
//
//   1. Parse + verify the signed `tc_oauth_state` cookie. Failures
//      → 400 + clear-cookie.
//   2. Compare `?state` against the cookie's `state`.
//   3. Reject if Google sent back `?error=…`.
//   4. Token-exchange `?code` + cookie's PKCE `verifier`.
//   5. JWKS-verify the returned `id_token` (audience = our client_id).
//   6. Allowlist-check `email` + require `email_verified=true`.
//      Disallowed → 302 to `/` with the state cookie cleared.
//   7. Mint a signed `tc_session` cookie carrying a fresh `sid`.
//   8. 302 to `/editor` (configurable).
//
// Session-row persistence (user upsert + sessions insert) is the
// caller's job, injected as `createSession(claims)` →
// `Promise<sid>`. The orchestrator stays pure; failures bubble up
// to a 500 branch so DB outages produce a real error, not a
// silently-broken cookie.

import {
  signSessionToken,
  verifyStateCookie,
  type StateVerifyFailure,
} from "@tex-center/auth";

import { formatClearCookie, formatSetCookie } from "./cookies.js";
import { errorMessage } from "../errors.js";

/** Already-verified ID token claims surfaced by `verifyIdToken`. */
export interface VerifiedIdToken {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** `name` claim, if present. */
  readonly name: string | null;
}

export interface ExchangeCodeInput {
  readonly code: string;
  readonly verifier: string;
}

export interface ExchangedTokens {
  readonly idToken: string;
}

export type ExchangeCodeFn = (
  input: ExchangeCodeInput,
) => Promise<ExchangedTokens>;

export interface VerifyIdTokenInput {
  readonly idToken: string;
  readonly audience: string;
}

export type VerifyIdTokenFn = (
  input: VerifyIdTokenInput,
) => Promise<VerifiedIdToken>;

/** Allowlist check, e.g. `(e) => isAllowedEmail(e)`. */
export type AllowEmailFn = (email: string | null) => boolean;

export interface ResolveGoogleCallbackInput {
  /** Value of the `tc_oauth_state` cookie, or `null` if absent. */
  readonly stateCookieValue: string | null;
  /** `?state` from the redirect-back URL. */
  readonly queryState: string | null;
  /** `?code` from the redirect-back URL. */
  readonly queryCode: string | null;
  /** `?error` from the redirect-back URL (Google can return one). */
  readonly queryError: string | null;
  /** OAuth client_id; ID-token audience. */
  readonly clientId: string;
  /** HMAC key for both state-cookie verify and session-cookie sign. */
  readonly signingKey: Uint8Array;
  /** Allowlist check, e.g. `isAllowedEmail` from `@tex-center/auth`. */
  readonly isEmailAllowed: AllowEmailFn;
  /** Unix epoch seconds at "now". */
  readonly nowSeconds: number;
  /** Session cookie lifetime, seconds. */
  readonly sessionTtlSeconds: number;
  /** Whether to emit the `Secure` attribute on the session cookie. */
  readonly secureCookie: boolean;
  /** State cookie name (to clear it on every termination). */
  readonly stateCookieName: string;
  /** Session cookie name. */
  readonly sessionCookieName: string;
  /** Final redirect target on success. */
  readonly successPath: string;
  /** Redirect target when the email is not allowed. */
  readonly signedOutPath: string;
  /**
   * Persist the session for the verified user and return a fresh
   * opaque session id (uuid) to embed in the signed cookie. The
   * production binding upserts the user by `google_sub` and inserts
   * a `sessions` row; tests inject a deterministic stub. Failures
   * are caught and surfaced as 500.
   */
  readonly createSession: (claims: VerifiedIdToken) => Promise<string>;
  readonly exchangeCode: ExchangeCodeFn;
  readonly verifyIdToken: VerifyIdTokenFn;
}

export type GoogleCallbackResolution =
  | {
      readonly kind: "redirect";
      readonly location: string;
      readonly setCookies: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly body: string;
      readonly setCookies: readonly string[];
    };

/**
 * Inputs to {@link finalizeGoogleSession}. Subset of
 * {@link ResolveGoogleCallbackInput} that applies once an ID token has been
 * verified — covers allowlist gating, DB session persistence, and signed
 * session-cookie minting. Factored out so an authenticated test path can
 * drive the same finalisation without going through the full PKCE/code
 * exchange (see M8.pw.3).
 */
export interface FinalizeGoogleSessionInput {
  readonly claims: VerifiedIdToken;
  readonly signingKey: Uint8Array;
  readonly isEmailAllowed: AllowEmailFn;
  readonly nowSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly secureCookie: boolean;
  readonly sessionCookieName: string;
  readonly successPath: string;
  readonly signedOutPath: string;
  readonly createSession: (claims: VerifiedIdToken) => Promise<string>;
  /**
   * Set-Cookie headers to prepend on every termination (e.g. clearing a
   * one-shot state cookie). Optional; defaults to none.
   */
  readonly priorSetCookies?: readonly string[];
}

export async function finalizeGoogleSession(
  input: FinalizeGoogleSessionInput,
): Promise<GoogleCallbackResolution> {
  const prior = input.priorSetCookies ?? [];

  if (!input.claims.emailVerified || !input.isEmailAllowed(input.claims.email)) {
    return {
      kind: "redirect",
      location: input.signedOutPath,
      setCookies: [...prior],
    };
  }

  let sid: string;
  try {
    sid = await input.createSession(input.claims);
  } catch (err) {
    return errorWith(
      500,
      `Session persistence failed: ${errorMessage(err)}`,
      [...prior],
    );
  }
  const exp = input.nowSeconds + input.sessionTtlSeconds;
  const sessionToken = signSessionToken({ sid, exp }, input.signingKey);
  const sessionCookie = formatSetCookie({
    name: input.sessionCookieName,
    value: sessionToken,
    path: "/",
    maxAgeSeconds: input.sessionTtlSeconds,
    secure: input.secureCookie,
  });

  return {
    kind: "redirect",
    location: input.successPath,
    setCookies: [...prior, sessionCookie],
  };
}

const STATE_RE = /^[A-Za-z0-9_-]+$/u;

export async function resolveGoogleCallback(
  input: ResolveGoogleCallbackInput,
): Promise<GoogleCallbackResolution> {
  const clearState = formatClearCookie({
    name: input.stateCookieName,
    path: "/auth",
    secure: input.secureCookie,
  });

  if (input.queryError !== null && input.queryError !== "") {
    // `access_denied` is the OAuth 2.0 spec code for "user cancelled
    // on the consent screen" — expected user behaviour, not an error
    // to display. Send them back to the white sign-in page, matching
    // the allowlist-deny branch below. Any other `error=` code is
    // genuinely unexpected (Google misconfig, malformed request) and
    // surfaces as a 400 with the code echoed for the operator.
    if (input.queryError === "access_denied") {
      return {
        kind: "redirect",
        location: input.signedOutPath,
        setCookies: [clearState],
      };
    }
    return errorWith(400, `OAuth error from Google: ${redactError(input.queryError)}`, [
      clearState,
    ]);
  }
  if (input.stateCookieValue === null || input.stateCookieValue === "") {
    return errorWith(400, "Missing OAuth state cookie.", [clearState]);
  }
  if (input.queryState === null || input.queryState === "") {
    return errorWith(400, "Missing state parameter.", [clearState]);
  }
  if (input.queryCode === null || input.queryCode === "") {
    return errorWith(400, "Missing code parameter.", [clearState]);
  }
  if (!STATE_RE.test(input.queryState)) {
    return errorWith(400, "Malformed state parameter.", [clearState]);
  }

  const stateVerify = verifyStateCookie(
    input.stateCookieValue,
    input.signingKey,
    input.nowSeconds,
  );
  if (!stateVerify.ok) {
    return errorWith(400, stateCookieErrorMessage(stateVerify.reason), [clearState]);
  }
  if (stateVerify.payload.state !== input.queryState) {
    return errorWith(400, "State mismatch.", [clearState]);
  }

  let tokens: ExchangedTokens;
  try {
    tokens = await input.exchangeCode({
      code: input.queryCode,
      verifier: stateVerify.payload.verifier,
    });
  } catch (err) {
    return errorWith(
      502,
      `Token exchange failed: ${errorMessage(err)}`,
      [clearState],
    );
  }

  let claims: VerifiedIdToken;
  try {
    claims = await input.verifyIdToken({
      idToken: tokens.idToken,
      audience: input.clientId,
    });
  } catch (err) {
    return errorWith(
      401,
      `ID token verification failed: ${errorMessage(err)}`,
      [clearState],
    );
  }

  return finalizeGoogleSession({
    claims,
    signingKey: input.signingKey,
    isEmailAllowed: input.isEmailAllowed,
    nowSeconds: input.nowSeconds,
    sessionTtlSeconds: input.sessionTtlSeconds,
    secureCookie: input.secureCookie,
    sessionCookieName: input.sessionCookieName,
    successPath: input.successPath,
    signedOutPath: input.signedOutPath,
    createSession: input.createSession,
    priorSetCookies: [clearState],
  });
}

function errorWith(
  status: number,
  body: string,
  setCookies: readonly string[],
): GoogleCallbackResolution {
  return { kind: "error", status, body, setCookies };
}

/** Google `error` codes are short tokens (e.g. `access_denied`); echo them verbatim if alnum/_. */
function redactError(raw: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : "unknown";
}

function stateCookieErrorMessage(reason: StateVerifyFailure): string {
  switch (reason) {
    case "malformed":
      return "Malformed state cookie.";
    case "bad-signature":
      return "Invalid state cookie signature.";
    case "expired":
      return "State cookie expired; please retry sign-in.";
    case "bad-payload":
      return "Corrupt state cookie payload.";
  }
}
