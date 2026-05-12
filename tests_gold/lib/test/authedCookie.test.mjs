// Tests for `tests_gold/lib/src/authedCookie.ts` plus a smoke
// `import()` of `tests_gold/playwright/fixtures/authedPage.ts`
// (so that fixture's top-level type errors / missing imports
// surface in `tests_gold` rather than waiting for the first
// authed spec to load it).

import assert from "node:assert/strict";

import {
  buildLiveDbUrl,
  buildSessionCookieSpec,
  resolveLiveDbConfig,
  resolveLocalDbEnv,
} from "../src/authedCookie.ts";

const VALID_KEY_B64URL = Buffer.alloc(32, 0xab).toString("base64url");

function testResolveMissing() {
  const r = resolveLiveDbConfig({});
  assert.equal(r.ok, false);
  assert.deepEqual(
    [...r.missing].sort(),
    [
      "SESSION_SIGNING_KEY",
      "TEXCENTER_LIVE_DB_PASSWORD",
      "TEXCENTER_LIVE_USER_ID",
    ],
  );
}

function testResolvePartial() {
  const r = resolveLiveDbConfig({
    TEXCENTER_LIVE_DB_PASSWORD: "pw",
    SESSION_SIGNING_KEY: VALID_KEY_B64URL,
  });
  assert.equal(r.ok, false);
  assert.deepEqual([...r.missing], ["TEXCENTER_LIVE_USER_ID"]);
}

function testResolveHappyDefaults() {
  const r = resolveLiveDbConfig({
    TEXCENTER_LIVE_DB_PASSWORD: "s3cr3t",
    SESSION_SIGNING_KEY: VALID_KEY_B64URL,
    TEXCENTER_LIVE_USER_ID: "00000000-0000-0000-0000-000000000001",
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.app, "tex-center-db");
  assert.equal(r.config.localPort, 5433);
  assert.equal(r.config.remotePort, 5432);
  assert.equal(r.config.user, "postgres");
  assert.equal(r.config.database, "tex_center");
  assert.equal(r.config.password, "s3cr3t");
  assert.equal(
    r.config.userId,
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(r.config.signingKey.byteLength, 32);
}

function testResolveOverrides() {
  const r = resolveLiveDbConfig({
    TEXCENTER_LIVE_DB_PASSWORD: "pw",
    SESSION_SIGNING_KEY: VALID_KEY_B64URL,
    TEXCENTER_LIVE_USER_ID: "u",
    TEXCENTER_LIVE_DB_APP: "other-app",
    TEXCENTER_LIVE_DB_USER: "alice",
    TEXCENTER_LIVE_DB_NAME: "appdb",
    TEXCENTER_LIVE_DB_LOCAL_PORT: "6543",
    TEXCENTER_LIVE_DB_REMOTE_PORT: "5444",
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.app, "other-app");
  assert.equal(r.config.user, "alice");
  assert.equal(r.config.database, "appdb");
  assert.equal(r.config.localPort, 6543);
  assert.equal(r.config.remotePort, 5444);
}

function testResolveRejectsShortKey() {
  assert.throws(
    () =>
      resolveLiveDbConfig({
        TEXCENTER_LIVE_DB_PASSWORD: "pw",
        SESSION_SIGNING_KEY: Buffer.alloc(16, 1).toString("base64url"),
        TEXCENTER_LIVE_USER_ID: "u",
      }),
    /needs >=32/,
  );
}

function testResolveRejectsBadKey() {
  assert.throws(
    () =>
      resolveLiveDbConfig({
        TEXCENTER_LIVE_DB_PASSWORD: "pw",
        SESSION_SIGNING_KEY: "not base64url!!!",
        TEXCENTER_LIVE_USER_ID: "u",
      }),
    /base64url/,
  );
}

function testResolveRejectsBadPort() {
  assert.throws(
    () =>
      resolveLiveDbConfig({
        TEXCENTER_LIVE_DB_PASSWORD: "pw",
        SESSION_SIGNING_KEY: VALID_KEY_B64URL,
        TEXCENTER_LIVE_USER_ID: "u",
        TEXCENTER_LIVE_DB_LOCAL_PORT: "notanumber",
      }),
    /invalid port/,
  );
}

function testBuildLiveDbUrl() {
  const url = buildLiveDbUrl({
    app: "tex-center-db",
    localPort: 5433,
    remotePort: 5432,
    user: "postgres",
    password: "p@ss/word",
    database: "postgres",
    userId: "u",
    signingKey: new Uint8Array(32),
  });
  // Password special chars must be url-encoded.
  assert.equal(
    url,
    "postgres://postgres:p%40ss%2Fword@127.0.0.1:5433/postgres",
  );
}

function testBuildSessionCookieSpec() {
  const expiresAt = new Date(1_700_000_000_000);
  const spec = buildSessionCookieSpec({
    value: "abc.def.ghi",
    expiresAt,
    host: "tex.center",
  });
  assert.deepEqual(spec, {
    name: "tc_session",
    value: "abc.def.ghi",
    domain: "tex.center",
    path: "/",
    expires: 1_700_000_000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
}

function testBuildSessionCookieSpecOverrides() {
  const spec = buildSessionCookieSpec({
    value: "v",
    expiresAt: new Date(1_700_000_500_999),
    host: "127.0.0.1",
    cookieName: "other_cookie",
    secure: false,
  });
  assert.equal(spec.name, "other_cookie");
  assert.equal(spec.domain, "127.0.0.1");
  assert.equal(spec.secure, false);
  // Floor of ms→s.
  assert.equal(spec.expires, 1_700_000_500);
}

function testBuildSessionCookieSpecRejectsEmpty() {
  assert.throws(
    () =>
      buildSessionCookieSpec({
        value: "",
        expiresAt: new Date(),
        host: "tex.center",
      }),
    /empty cookie value/,
  );
  assert.throws(
    () =>
      buildSessionCookieSpec({
        value: "v",
        expiresAt: new Date(),
        host: "",
      }),
    /empty host/,
  );
}

async function testFixtureLoads() {
  // Confirms the Playwright fixture module parses, all imports
  // resolve, and the `test` extend call doesn't throw at module
  // top level. We don't run any browser here.
  const mod = await import(
    "../../playwright/fixtures/authedPage.ts"
  );
  assert.equal(typeof mod.test, "function");
  assert.equal(typeof mod.expect, "function");
}

function testResolveLocalMissing() {
  const r = resolveLocalDbEnv({});
  assert.equal(r.ok, false);
  assert.deepEqual(
    [...r.missing].sort(),
    ["DATABASE_URL", "SESSION_SIGNING_KEY", "TEXCENTER_LOCAL_USER_ID"],
  );
}

function testResolveLocalHappy() {
  const r = resolveLocalDbEnv({
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:54321/postgres",
    SESSION_SIGNING_KEY: VALID_KEY_B64URL,
    TEXCENTER_LOCAL_USER_ID: "00000000-0000-0000-0000-000000000007",
  });
  assert.equal(r.ok, true);
  assert.equal(
    r.config.url,
    "postgres://postgres:postgres@127.0.0.1:54321/postgres",
  );
  assert.equal(r.config.userId, "00000000-0000-0000-0000-000000000007");
  assert.equal(r.config.signingKey.byteLength, 32);
}

function testResolveLocalRejectsBadKey() {
  assert.throws(
    () =>
      resolveLocalDbEnv({
        DATABASE_URL: "postgres://x@127.0.0.1:5432/db",
        SESSION_SIGNING_KEY: "!!!not-base64url!!!",
        TEXCENTER_LOCAL_USER_ID: "u",
      }),
    /not valid base64url/,
  );
}

function testResolveLocalRejectsShortKey() {
  const shortKey = Buffer.alloc(16, 0xab).toString("base64url");
  assert.throws(
    () =>
      resolveLocalDbEnv({
        DATABASE_URL: "postgres://x@127.0.0.1:5432/db",
        SESSION_SIGNING_KEY: shortKey,
        TEXCENTER_LOCAL_USER_ID: "u",
      }),
    /needs >=32/,
  );
}

async function main() {
  testResolveMissing();
  testResolvePartial();
  testResolveHappyDefaults();
  testResolveOverrides();
  testResolveRejectsShortKey();
  testResolveRejectsBadKey();
  testResolveRejectsBadPort();
  testBuildLiveDbUrl();
  testBuildSessionCookieSpec();
  testBuildSessionCookieSpecOverrides();
  testBuildSessionCookieSpecRejectsEmpty();
  testResolveLocalMissing();
  testResolveLocalHappy();
  testResolveLocalRejectsBadKey();
  testResolveLocalRejectsShortKey();
  await testFixtureLoads();
  console.log("ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
