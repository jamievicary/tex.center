// Mint a fresh Google ID token using a stored refresh token.
//
// Used by `verifyLiveOauthCallback.spec.ts` (M8.pw.3.3) to drive a
// real Google-signed JWT through `POST /auth/google/test-callback`
// — the live deploy gate that would have caught iter 131's
// production-down user-upsert bug.
//
// The refresh token itself is obtained one-shot by
// `scripts/google-refresh-token.mjs` against a *separate* OAuth
// client (not the production `creds/google-oauth.json`), so this
// helper never needs the consent-screen flow.
//
// Pure I/O wrapper around the OAuth2 refresh-token grant
// (https://oauth2.googleapis.com/token). `fetchFn` and `tokenUrl`
// are injectable for unit tests; the gold runner uses the global
// `fetch`.
//
// On any non-2xx response, throws including the upstream status and
// a truncated body. On a 2xx response with no `id_token`, throws —
// the caller needs an ID token, not just an access token.

export interface MintGoogleIdTokenInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Override Google's token endpoint (tests). */
  readonly tokenUrl?: string;
  /** Override the global fetch (tests). */
  readonly fetchFn?: typeof fetch;
}

export interface MintedGoogleIdToken {
  readonly idToken: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function mintGoogleIdToken(
  input: MintGoogleIdTokenInput,
): Promise<MintedGoogleIdToken> {
  if (input.clientId === "") throw new Error("mintGoogleIdToken: clientId required");
  if (input.clientSecret === "") throw new Error("mintGoogleIdToken: clientSecret required");
  if (input.refreshToken === "") throw new Error("mintGoogleIdToken: refreshToken required");

  const fetchFn = input.fetchFn ?? fetch;
  const url = input.tokenUrl ?? TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Google token endpoint ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string" || json.id_token === "") {
    throw new Error("Google token response missing id_token");
  }
  return { idToken: json.id_token };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return "<no body>";
  }
}
