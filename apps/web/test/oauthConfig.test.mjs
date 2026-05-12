// Unit test for `loadOAuthConfig` env-vs-file precedence
// (FUTURE_IDEAS, iter 144).
//
// Covers:
//   - env-only path (no creds file present)
//   - file-only dev path (env vars unset, dev creds file fills client_id/secret)
//   - file-ignored-in-prod (NODE_ENV=production, no env vars → throws,
//     even if a creds file exists at the configured path)
//   - missing required env vars (redirect URI, signing key)
//   - signing-key validation (not base64url; too short)
//   - env beats file (both present → env wins)
//
// Each scenario stashes/restores `process.env` and calls
// `resetOAuthConfigForTests` so the module cache doesn't leak state.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  loadOAuthConfig,
  resetOAuthConfigForTests,
} from "../src/lib/server/oauthConfig.ts";

const tmp = mkdtempSync(join(tmpdir(), "tc-oauth-cfg-"));
const credsPath = join(tmp, "google-oauth.json");
const goodKey = randomBytes(32).toString("base64url");

const TOUCHED_KEYS = [
  "NODE_ENV",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_CREDS_PATH",
  "SESSION_SIGNING_KEY",
];

function snapshotEnv() {
  const saved = {};
  for (const k of TOUCHED_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved) {
  for (const k of TOUCHED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function withEnv(env, fn) {
  const saved = snapshotEnv();
  try {
    for (const k of TOUCHED_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    resetOAuthConfigForTests();
    fn();
  } finally {
    restoreEnv(saved);
    resetOAuthConfigForTests();
  }
}

try {
  // --- env-only path -------------------------------------------------
  withEnv(
    {
      // NODE_ENV unset (treated as non-production by oauthConfig — the
      // file-fallback gate is `=== "production"`). Point CREDS_PATH at
      // a nonexistent file so the file fallback finds nothing.
      GOOGLE_OAUTH_CREDS_PATH: join(tmp, "does-not-exist.json"),
      GOOGLE_OAUTH_CLIENT_ID: "env.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      const c = loadOAuthConfig();
      assert.equal(c.clientId, "env.apps.googleusercontent.com");
      assert.equal(c.clientSecret, "env-secret");
      assert.equal(c.redirectUri, "https://tex.center/auth/google/callback");
      assert.equal(c.signingKey.byteLength, 32);
    },
  );

  // --- file-only dev path -------------------------------------------
  writeFileSync(
    credsPath,
    JSON.stringify({
      client_id: "file.apps.googleusercontent.com",
      client_secret: "file-secret",
    }),
  );
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/auth/google/callback",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      const c = loadOAuthConfig();
      assert.equal(c.clientId, "file.apps.googleusercontent.com");
      assert.equal(c.clientSecret, "file-secret");
    },
  );

  // --- file ignored in production -----------------------------------
  // Creds file is present but NODE_ENV=production gates it off; with
  // no env vars set, loadOAuthConfig must throw rather than silently
  // succeed on file contents.
  withEnv(
    {
      NODE_ENV: "production",
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      assert.throws(loadOAuthConfig, /GOOGLE_OAUTH_CLIENT_ID/u);
    },
  );

  // --- env beats file ------------------------------------------------
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_CLIENT_ID: "env-wins",
      GOOGLE_OAUTH_CLIENT_SECRET: "env-wins-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      const c = loadOAuthConfig();
      assert.equal(c.clientId, "env-wins");
      assert.equal(c.clientSecret, "env-wins-secret");
    },
  );

  // --- missing redirect URI -----------------------------------------
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_CLIENT_ID: "x",
      GOOGLE_OAUTH_CLIENT_SECRET: "y",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      assert.throws(loadOAuthConfig, /GOOGLE_OAUTH_REDIRECT_URI/u);
    },
  );

  // --- missing signing key ------------------------------------------
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_CLIENT_ID: "x",
      GOOGLE_OAUTH_CLIENT_SECRET: "y",
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
    },
    () => {
      assert.throws(loadOAuthConfig, /SESSION_SIGNING_KEY/u);
    },
  );

  // --- signing key: malformed (not base64url) -----------------------
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_CLIENT_ID: "x",
      GOOGLE_OAUTH_CLIENT_SECRET: "y",
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: "has spaces and + slashes/",
    },
    () => {
      assert.throws(loadOAuthConfig, /base64url/u);
    },
  );

  // --- signing key: too short ---------------------------------------
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: credsPath,
      GOOGLE_OAUTH_CLIENT_ID: "x",
      GOOGLE_OAUTH_CLIENT_SECRET: "y",
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: randomBytes(16).toString("base64url"),
    },
    () => {
      assert.throws(loadOAuthConfig, /needs >=32/u);
    },
  );

  // --- malformed creds file (non-JSON) is treated as absent ---------
  // The dev fallback swallows parse errors so a corrupted file
  // doesn't mask the env-var error message. With no env vars, that
  // means we still see the "missing GOOGLE_OAUTH_CLIENT_ID" message.
  const badPath = join(tmp, "bad.json");
  writeFileSync(badPath, "{not json");
  withEnv(
    {
      GOOGLE_OAUTH_CREDS_PATH: badPath,
      GOOGLE_OAUTH_REDIRECT_URI: "https://tex.center/auth/google/callback",
      SESSION_SIGNING_KEY: goodKey,
    },
    () => {
      assert.throws(loadOAuthConfig, /GOOGLE_OAUTH_CLIENT_ID/u);
    },
  );

  console.log("apps/web oauthConfig: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
