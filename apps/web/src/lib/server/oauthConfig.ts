// Load the Google OAuth config + cookie signing key from env / disk.
//
// Throws on first access with a one-line message naming the
// missing env var or file. The route handler catches it and
// returns 500 with that message rather than letting SvelteKit's
// error page leak — silent fallback would emit a redirect Google
// can't honour (no client_id) or an unverifiable cookie (no key).
//
// `client_id` is sourced from `creds/google-oauth.json` per
// GOAL.md (the canonical location). `GOOGLE_OAUTH_CLIENT_ID` env
// overrides if set, mainly for tests.
//
// `SESSION_SIGNING_KEY` is the HMAC key, base64url-encoded, ≥32
// bytes. Same key signs the state cookie and (M5.1.2 onward) the
// session cookie — they're independent payloads with different
// shapes, so a stolen state cookie can't be replayed as a session.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly signingKey: Uint8Array;
}

let cached: OAuthConfig | null = null;

export function loadOAuthConfig(): OAuthConfig {
  if (cached) return cached;

  const credsPath = resolve(
    process.cwd(),
    process.env.GOOGLE_OAUTH_CREDS_PATH ?? "creds/google-oauth.json",
  );

  let credsJson: { client_id?: unknown; client_secret?: unknown };
  try {
    credsJson = JSON.parse(readFileSync(credsPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read Google OAuth credentials from ${credsPath}: ${reason}. ` +
        `Create the file with {"client_id": "...", "client_secret": "..."}.`,
    );
  }

  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID ??
    (typeof credsJson.client_id === "string" ? credsJson.client_id : "");
  if (!clientId) {
    throw new Error(
      `Missing client_id in ${credsPath} (and no GOOGLE_OAUTH_CLIENT_ID env override).`,
    );
  }

  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    (typeof credsJson.client_secret === "string" ? credsJson.client_secret : "");
  if (!clientSecret) {
    throw new Error(
      `Missing client_secret in ${credsPath} (and no GOOGLE_OAUTH_CLIENT_SECRET env override).`,
    );
  }

  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error(
      "Missing GOOGLE_OAUTH_REDIRECT_URI env var. " +
        "Set to e.g. https://tex.center/auth/google/callback in prod " +
        "or http://localhost:3000/auth/google/callback in dev.",
    );
  }

  const keyB64u = process.env.SESSION_SIGNING_KEY;
  if (!keyB64u) {
    throw new Error(
      "Missing SESSION_SIGNING_KEY env var. " +
        "Set to base64url(>=32 random bytes); e.g. " +
        '`SESSION_SIGNING_KEY=$(node -e \'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))\')`.',
    );
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(keyB64u)) {
    throw new Error("SESSION_SIGNING_KEY is not valid base64url.");
  }
  const signingKey = Buffer.from(keyB64u, "base64url");
  if (signingKey.byteLength < 32) {
    throw new Error(
      `SESSION_SIGNING_KEY decodes to ${signingKey.byteLength} bytes; needs >=32.`,
    );
  }

  cached = { clientId, clientSecret, redirectUri, signingKey };
  return cached;
}

/** For tests: drop the cached config so the next call re-reads env. */
export function resetOAuthConfigForTests(): void {
  cached = null;
}
