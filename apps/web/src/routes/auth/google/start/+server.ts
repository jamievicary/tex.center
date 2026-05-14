// GET /auth/google/start
//
// First leg of the OAuth Authorization Code + PKCE flow. Mints a
// signed state cookie carrying the PKCE verifier and a CSRF state
// value, then 302-redirects to Google's authorize URL. The callback
// (M5.1.2) verifies the cookie before exchanging the code.
//
// `prerender = false` is implicit for `+server.ts`, but we set
// `Cache-Control: no-store` because a 302 with a `code_challenge` is
// meaningful only for this state-cookie pair.

import { randomBytes } from "node:crypto";

import { generatePkce } from "@tex-center/auth";
import type { RequestHandler } from "@sveltejs/kit";

import { errorMessage } from "$lib/errors.js";
import {
  loadOAuthConfig,
} from "$lib/server/oauthConfig.js";
import {
  buildGoogleAuthorizeRedirect,
} from "$lib/server/oauthStart.js";

const STATE_COOKIE_NAME = "tc_oauth_state";
const STATE_TTL_SECONDS = 600; // 10 minutes

export const GET: RequestHandler = ({ url }) => {
  let config;
  try {
    config = loadOAuthConfig();
  } catch (err) {
    return new Response(`Server misconfigured: ${errorMessage(err)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const pkce = generatePkce();
  const state = randomBytes(32).toString("base64url");
  const nowSeconds = Math.floor(Date.now() / 1000);

  const { location, stateCookie } = buildGoogleAuthorizeRedirect({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    signingKey: config.signingKey,
    pkce,
    state,
    nowSeconds,
    stateTtlSeconds: STATE_TTL_SECONDS,
    // Same-origin localhost dev runs on http; everywhere else is https.
    secureCookie: url.protocol === "https:",
    cookieName: STATE_COOKIE_NAME,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": stateCookie,
      "Cache-Control": "no-store",
    },
  });
};
