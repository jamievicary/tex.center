// Pure-logic auth primitives for tex.center.
//
// Two concerns, both pure (no I/O, no network):
//
//   1. The email allowlist. MVP admits exactly one address
//      (jamievicary@gmail.com per GOAL.md); the policy lives here
//      so the OAuth callback and any future re-check share one
//      definition.
//
//   2. Session tokens. After a successful Google sign-in the web
//      tier mints an opaque cookie that round-trips back as the
//      session id. We sign a small JSON payload (session uuid +
//      expiry) with HMAC-SHA256 and base64url-encode the whole
//      thing. The signing key is supplied by the caller — there is
//      no module-level state.
//
// The full OAuth state machine (PKCE, JWKS verify, callback
// handling) lives a layer up; this module is the leaf both the
// future control-plane code and its unit tests depend on.

export { isAllowedEmail, ALLOWED_EMAILS } from "./allowlist.js";
export {
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
  type VerifyResult,
} from "./session.js";
export {
  generatePkce,
  computeChallenge,
  isValidVerifier,
  type PkcePair,
} from "./pkce.js";
export {
  signStateCookie,
  verifyStateCookie,
  type StatePayload,
  type StateVerifyResult,
  type StateVerifyFailure,
} from "./state.js";
