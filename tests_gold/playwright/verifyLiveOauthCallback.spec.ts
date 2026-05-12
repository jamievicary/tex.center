// Live OAuth callback round-trip probe (M8.pw.3.3).
//
// Drives the post-token-exchange half of the real Google OAuth
// callback against production: mints a fresh Google ID token via
// the refresh-token grant (creds/google-refresh-token.txt against
// creds/google-oauth-test.json), POSTs it to the test-only
// finaliser route /auth/google/test-callback with the X-Test-Bypass
// HMAC header, asserts 302 → /projects + a tc_session cookie,
// then GETs /projects with that cookie and asserts 200 — proving
// the same JWKS-verify → allowlist → DB-upsert → cookie-mint path
// the real callback runs.
//
// Why this exists: iter 129 (`jose` ERR_MODULE_NOT_FOUND) and iter
// 131 (UNIQUE(email) collision in user upsert) were both
// production-down OAuth-callback bugs invisible to the prior
// verification surface (cookie-injection authed probes). M8.pw.3
// closes that gap.
//
// Gating: live project only; all of the following must be present
// or the test self-skips (so the default `tests_gold` run stays
// green):
//   - `TEST_OAUTH_BYPASS_KEY` env var (must match the Fly secret of
//     the same name on `tex-center`);
//   - `creds/google-oauth-test.json` (clientId + clientSecret of
//     the dedicated test OAuth client; *not* the production client);
//   - `creds/google-refresh-token.txt` (one-shot via
//     `scripts/google-refresh-token.mjs`).
//
// Cleanup: the OAuth path inserts a fresh `sessions` row. We extract
// the sid from the signed cookie via `verifySessionToken` and
// `deleteSession` it in a try/finally. The `users` row is left
// alone — the live seed row was aligned to the real google_sub by
// the iter-131 fix, so the upsert UPDATEs the existing row in place
// rather than inserting a new one.

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import path from "node:path";

import { verifySessionToken } from "@tex-center/auth";
import { deleteSession } from "@tex-center/db";

import { mintGoogleIdToken } from "../lib/src/mintGoogleIdToken.js";

import { test, expect } from "./fixtures/authedPage.js";

const LIVE_HOST = "tex.center";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OAUTH_TEST_CREDS = path.join(
  REPO_ROOT,
  "creds",
  "google-oauth-test.json",
);
const REFRESH_TOKEN_FILE = path.join(
  REPO_ROOT,
  "creds",
  "google-refresh-token.txt",
);

interface OauthClientCreds {
  readonly clientId: string;
  readonly clientSecret: string;
}

type CredsLoadResult =
  | {
      readonly ok: true;
      readonly creds: OauthClientCreds;
      readonly refreshToken: string;
    }
  | { readonly ok: false; readonly missing: readonly string[] };

async function readOptionalFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadCreds(): Promise<CredsLoadResult> {
  const missing: string[] = [];
  const json = await readOptionalFile(OAUTH_TEST_CREDS);
  if (json === null) missing.push(OAUTH_TEST_CREDS);
  const refreshRaw = await readOptionalFile(REFRESH_TOKEN_FILE);
  if (refreshRaw === null) missing.push(REFRESH_TOKEN_FILE);
  if (missing.length > 0) return { ok: false, missing };

  let parsed: { client_id?: unknown; client_secret?: unknown };
  try {
    parsed = JSON.parse(json!) as typeof parsed;
  } catch (err) {
    throw new Error(
      `failed to parse ${OAUTH_TEST_CREDS}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed.client_id !== "string" || parsed.client_id === "") {
    throw new Error(`${OAUTH_TEST_CREDS}: missing/empty client_id`);
  }
  if (
    typeof parsed.client_secret !== "string" ||
    parsed.client_secret === ""
  ) {
    throw new Error(`${OAUTH_TEST_CREDS}: missing/empty client_secret`);
  }
  const refreshToken = refreshRaw!.trim();
  if (refreshToken === "") {
    throw new Error(`${REFRESH_TOKEN_FILE}: empty`);
  }
  return {
    ok: true,
    creds: {
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
    },
    refreshToken,
  };
}

test.describe("live OAuth callback round-trip", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveOauthCallback runs only on the live project",
    );
  });

  test("test-callback → 302 /projects + working tc_session", async ({
    db,
  }) => {
    const bypassKey = process.env.TEST_OAUTH_BYPASS_KEY ?? "";
    test.skip(
      bypassKey === "",
      "TEST_OAUTH_BYPASS_KEY env var required (must match Fly secret on tex-center)",
    );

    const loaded = await loadCreds();
    if (!loaded.ok) {
      test.skip(
        true,
        `verifyLiveOauthCallback: missing creds: ${loaded.missing.join(", ")}`,
      );
      return;
    }

    // Network round-trips: refresh-token grant + live POST + live
    // GET. Each is well under 10s in normal operation; 60s leaves
    // generous slack without being a timeout-as-synchronisation
    // smell.
    test.setTimeout(60_000);

    const minted = await mintGoogleIdToken({
      clientId: loaded.creds.clientId,
      clientSecret: loaded.creds.clientSecret,
      refreshToken: loaded.refreshToken,
    });

    const bodyText = JSON.stringify({ idToken: minted.idToken });
    const bypassHeader = createHmac(
      "sha256",
      Buffer.from(bypassKey, "utf8"),
    )
      .update(bodyText, "utf8")
      .digest("hex");

    const post = await rawPost({
      host: LIVE_HOST,
      port: 443,
      path: "/auth/google/test-callback",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Bypass": bypassHeader,
      },
      body: bodyText,
    });

    expect(
      post.status,
      `POST /auth/google/test-callback body=${post.body.slice(0, 256)}`,
    ).toBe(302);
    expect(post.location).toBe("/projects");

    const cookieValue = extractTcSession(post.setCookies);
    expect(
      cookieValue,
      `Set-Cookie headers: ${JSON.stringify(post.setCookies)}`,
    ).not.toBeNull();

    let sidToCleanup: string | null = null;
    try {
      // Surface a verifier-side regression directly even before
      // the round-trip to /projects (where a hook-side bug would
      // present as the same 302 → /).
      const verified = verifySessionToken(cookieValue!, db.signingKey);
      expect(
        verified.ok,
        `verifySessionToken: ${JSON.stringify(verified)}`,
      ).toBe(true);
      if (verified.ok) sidToCleanup = verified.payload.sid;

      const get = await rawGet({
        host: LIVE_HOST,
        port: 443,
        path: "/projects",
        headers: { Cookie: `tc_session=${cookieValue}` },
      });
      expect(get.status, `body=${get.body.slice(0, 256)}`).toBe(200);
    } finally {
      if (sidToCleanup !== null) {
        await deleteSession(db.db.db, sidToCleanup).catch((e) => {
          // eslint-disable-next-line no-console
          console.error("deleteSession cleanup failed:", e);
        });
      }
    }
  });
});

interface RawResult {
  readonly status: number;
  readonly location: string | undefined;
  readonly setCookies: readonly string[];
  readonly body: string;
}

interface RawPostArgs {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface RawGetArgs {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers: Record<string, string>;
}

function rawPost(args: RawPostArgs): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      host: args.host,
      port: args.port,
      method: "POST",
      path: args.path,
      headers: {
        Host: args.host,
        "Content-Length": String(Buffer.byteLength(args.body, "utf8")),
        ...args.headers,
      },
    };
    const req = httpsRequest(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(buildResult(res, Buffer.concat(chunks))));
    });
    req.on("error", reject);
    req.end(args.body);
  });
}

function rawGet(args: RawGetArgs): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      host: args.host,
      port: args.port,
      method: "GET",
      path: args.path,
      headers: { Host: args.host, ...args.headers },
    };
    const req = httpsRequest(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(buildResult(res, Buffer.concat(chunks))));
    });
    req.on("error", reject);
    req.end();
  });
}

function buildResult(res: IncomingMessage, body: Buffer): RawResult {
  const raw = res.headers["set-cookie"];
  const setCookies = Array.isArray(raw)
    ? raw
    : raw === undefined
      ? []
      : [raw];
  return {
    status: res.statusCode ?? 0,
    location:
      typeof res.headers.location === "string"
        ? res.headers.location
        : undefined,
    setCookies,
    body: body.toString("utf8"),
  };
}

function extractTcSession(setCookies: readonly string[]): string | null {
  for (const c of setCookies) {
    const m = /^tc_session=([^;]+)/.exec(c);
    if (m !== null) {
      try {
        return decodeURIComponent(m[1]!);
      } catch {
        return m[1]!;
      }
    }
  }
  return null;
}
