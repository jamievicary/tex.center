// POST /auth/google/test-callback
//
// Test-only finaliser route (M8.pw.3.1). Gated on the
// `TEST_OAUTH_BYPASS_KEY` env var — returns 404 when unset so the
// route is invisible in environments that haven't opted in. When the
// key is set, the request must carry an `X-Test-Bypass` header equal
// to HMAC-SHA256(key, body) in lowercase hex.
//
// The ID-token cryptographic check (`verifyGoogleIdToken`) and the
// DB-backed `finalizeGoogleSession` path are unchanged from the real
// `/auth/google/callback` — only the PKCE/code-exchange leg is
// skipped. See `$lib/server/testOauthCallback.ts` for the pure
// orchestrator.

import { isAllowedEmail } from "@tex-center/auth";
import {
  findOrCreateUserByGoogleSub,
  insertSession,
} from "@tex-center/db";
import type { RequestHandler } from "@sveltejs/kit";

import { errorMessage } from "$lib/errors.js";
import { loadOAuthConfig } from "$lib/server/oauthConfig.js";
import {
  finalizeGoogleSession,
  type GoogleCallbackResolution,
} from "$lib/server/oauthCallback.js";
import { resolveTestCallback } from "$lib/server/testOauthCallback.js";
import { getDb } from "$lib/server/db.js";
import { verifyGoogleIdToken } from "$lib/server/googleTokens.js";

const SESSION_COOKIE_NAME = "tc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SUCCESS_PATH = "/projects";
const SIGNED_OUT_PATH = "/";

export const POST: RequestHandler = async ({ url, request }) => {
  const bypassKeyRaw = process.env.TEST_OAUTH_BYPASS_KEY ?? "";
  if (bypassKeyRaw === "") {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let config;
  try {
    config = loadOAuthConfig();
  } catch (err) {
    return new Response(`Server misconfigured: ${errorMessage(err)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const bodyText = await request.text();
  const result = await resolveTestCallback({
    bodyText,
    bypassHeader: request.headers.get("x-test-bypass"),
    bypassKey: Buffer.from(bypassKeyRaw, "utf8"),
    audience: config.clientId,
    verifyIdToken: verifyGoogleIdToken,
    finalize: (claims) =>
      finalizeGoogleSession({
        claims,
        signingKey: config.signingKey,
        isEmailAllowed: isAllowedEmail,
        nowSeconds: Math.floor(Date.now() / 1000),
        sessionTtlSeconds: SESSION_TTL_SECONDS,
        secureCookie: url.protocol === "https:",
        sessionCookieName: SESSION_COOKIE_NAME,
        successPath: SUCCESS_PATH,
        signedOutPath: SIGNED_OUT_PATH,
        createSession: async (verified) => {
          const { db } = getDb();
          if (verified.email === null) {
            throw new Error(
              "createSession: verified ID token has no email",
            );
          }
          const user = await findOrCreateUserByGoogleSub(db, {
            googleSub: verified.sub,
            email: verified.email,
            displayName: verified.name,
          });
          const expiresAt = new Date(
            (Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS) * 1000,
          );
          const session = await insertSession(db, {
            userId: user.id,
            expiresAt,
          });
          return session.id;
        },
      }),
  });

  return toResponse(result);
};

function toResponse(r: GoogleCallbackResolution): Response {
  const headers = new Headers();
  for (const c of r.setCookies) headers.append("Set-Cookie", c);
  headers.set("Cache-Control", "no-store");
  if (r.kind === "redirect") {
    headers.set("Location", r.location);
    return new Response(null, { status: 302, headers });
  }
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(r.body, { status: r.status, headers });
}
