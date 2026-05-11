// GET /auth/google/callback
//
// Final leg of the OAuth Authorization Code + PKCE flow. Verifies
// the state cookie, exchanges the auth code for tokens, JWKS-
// verifies the ID token, checks the email allowlist, and mints a
// signed session cookie. See `$lib/server/oauthCallback.ts` for the
// pure orchestrator; this file wires the real I/O.

import { isAllowedEmail } from "@tex-center/auth";
import {
  findOrCreateUserByGoogleSub,
  insertSession,
} from "@tex-center/db";
import type { RequestHandler } from "@sveltejs/kit";

import { loadOAuthConfig } from "$lib/server/oauthConfig.js";
import { resolveGoogleCallback } from "$lib/server/oauthCallback.js";
import { readCookie } from "$lib/server/cookies.js";
import { getDb } from "$lib/server/db.js";
import {
  makeExchangeCodeForTokens,
  verifyGoogleIdToken,
} from "$lib/server/googleTokens.js";

const STATE_COOKIE_NAME = "tc_oauth_state";
const SESSION_COOKIE_NAME = "tc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SUCCESS_PATH = "/projects";
const SIGNED_OUT_PATH = "/";

export const GET: RequestHandler = async ({ url, request }) => {
  let config;
  try {
    config = loadOAuthConfig();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return new Response(`Server misconfigured: ${reason}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const stateCookieValue = readCookie(
    request.headers.get("cookie"),
    STATE_COOKIE_NAME,
  );

  const result = await resolveGoogleCallback({
    stateCookieValue,
    queryState: url.searchParams.get("state"),
    queryCode: url.searchParams.get("code"),
    queryError: url.searchParams.get("error"),
    clientId: config.clientId,
    signingKey: config.signingKey,
    isEmailAllowed: isAllowedEmail,
    nowSeconds: Math.floor(Date.now() / 1000),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    secureCookie: url.protocol === "https:",
    stateCookieName: STATE_COOKIE_NAME,
    sessionCookieName: SESSION_COOKIE_NAME,
    successPath: SUCCESS_PATH,
    signedOutPath: SIGNED_OUT_PATH,
    createSession: async (claims) => {
      const { db } = getDb();
      if (claims.email === null) {
        // Allowlist gate runs before us, but guard the type narrowing:
        // an allowed email is always non-null in practice.
        throw new Error("createSession: verified ID token has no email");
      }
      const user = await findOrCreateUserByGoogleSub(db, {
        googleSub: claims.sub,
        email: claims.email,
        displayName: claims.name,
      });
      const expiresAt = new Date(
        (Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS) * 1000,
      );
      const session = await insertSession(db, { userId: user.id, expiresAt });
      return session.id;
    },
    exchangeCode: makeExchangeCodeForTokens({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    }),
    verifyIdToken: verifyGoogleIdToken,
  });

  return toResponse(result);
};

function toResponse(
  r: Awaited<ReturnType<typeof resolveGoogleCallback>>,
): Response {
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

