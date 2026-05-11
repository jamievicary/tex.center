// Load the Google OAuth config + cookie signing key.
//
// Production reads from env vars only — the deployed image must not
// contain `creds/` (gitignored, dockerignored), so any file-fallback
// here would mask the real misconfiguration with a confusing
// ENOENT (caused incident, discussion 76).
//
// Local dev keeps a convenience fallback to `creds/google-oauth.json`
// for `client_id`/`client_secret` when those env vars are absent and
// we are not in production. `SESSION_SIGNING_KEY` and
// `GOOGLE_OAUTH_REDIRECT_URI` are env-only on every path — those are
// trivial to set in `apps/web/.env.local` for dev.
//
// Throws on first access with a one-line message naming the
// missing env var. The route handler catches it and returns 500
// with that message rather than letting SvelteKit's error page
// leak — silent fallback would emit a redirect Google can't honour
// (no client_id) or an unverifiable cookie (no key).
//
// Env var names use the `GOOGLE_OAUTH_` prefix to disambiguate from
// any future Google API usage in this codebase.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly signingKey: Uint8Array;
}

let cached: OAuthConfig | null = null;

function readDevCredsFile(): { client_id?: unknown; client_secret?: unknown } | null {
  if (process.env.NODE_ENV === "production") return null;
  const credsPath = resolve(
    process.cwd(),
    process.env.GOOGLE_OAUTH_CREDS_PATH ?? "creds/google-oauth.json",
  );
  try {
    return JSON.parse(readFileSync(credsPath, "utf8"));
  } catch {
    return null;
  }
}

export function loadOAuthConfig(): OAuthConfig {
  if (cached) return cached;

  let devCreds: { client_id?: unknown; client_secret?: unknown } | null = null;
  const needDevCreds = () => {
    if (devCreds === null) devCreds = readDevCredsFile() ?? {};
    return devCreds;
  };

  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  if (!clientId) {
    const f = needDevCreds();
    if (typeof f.client_id === "string") clientId = f.client_id;
  }
  if (!clientId) {
    throw new Error(
      "Missing GOOGLE_OAUTH_CLIENT_ID env var (set via `flyctl secrets set` " +
        "in production; for local dev, place creds/google-oauth.json with a " +
        '`client_id` field).',
    );
  }

  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  if (!clientSecret) {
    const f = needDevCreds();
    if (typeof f.client_secret === "string") clientSecret = f.client_secret;
  }
  if (!clientSecret) {
    throw new Error(
      "Missing GOOGLE_OAUTH_CLIENT_SECRET env var (set via `flyctl secrets " +
        "set` in production; for local dev, place creds/google-oauth.json " +
        'with a `client_secret` field).',
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
