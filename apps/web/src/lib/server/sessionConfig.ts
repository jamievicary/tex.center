// Load just the session signing key from env.
//
// `hooks.server.ts` runs on every request including unauthenticated
// visits to the white sign-in page, where the full OAuth config
// (`creds/google-oauth.json`) is not needed. Keep the dependency
// surface minimal so a missing creds file doesn't break anonymous
// page loads.
//
// Returns `null` if `SESSION_SIGNING_KEY` is unset. Throws on a
// malformed value (the operator wanted to set it but botched the
// format — silently treating that as "no auth" would be worse).

let cached: Uint8Array | null | undefined;

export function loadSessionSigningKey(): Uint8Array | null {
  if (cached !== undefined) return cached;
  const raw = process.env.SESSION_SIGNING_KEY;
  if (!raw) {
    cached = null;
    return cached;
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new Error("SESSION_SIGNING_KEY is not valid base64url.");
  }
  const key = Buffer.from(raw, "base64url");
  if (key.byteLength < 32) {
    throw new Error(
      `SESSION_SIGNING_KEY decodes to ${key.byteLength} bytes; needs >=32.`,
    );
  }
  cached = key;
  return cached;
}

/** For tests: drop the cached key so the next call re-reads env. */
export function resetSessionSigningKeyForTests(): void {
  cached = undefined;
}
