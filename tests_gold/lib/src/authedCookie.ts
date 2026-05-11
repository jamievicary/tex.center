// Pure helpers backing `tests_gold/playwright/fixtures/authedPage.ts`.
//
// Two small, separately-testable units:
//
//   - `resolveLiveDbConfig(env)` — read the env vars the
//     `authedPage` fixture needs (live DB password, signing key,
//     pre-existing user id, plus optional overrides for user /
//     database name / port / app). Returns either a fully
//     populated config or the list of missing required keys so
//     the fixture can `test.skip` with an informative reason.
//
//   - `buildSessionCookieSpec({ ... })` — produce the
//     `addCookies`-shaped object Playwright wants. The shape must
//     mirror `apps/web/src/lib/server/cookies.ts#formatSetCookie`:
//     `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` in prod,
//     `expires` as unix seconds.
//
// Keeping these pure means the fixture itself is thin glue and
// we can unit-test the cookie spec without booting Playwright,
// flyctl, or Postgres.

export interface LiveDbConfig {
  readonly app: string;
  readonly localPort: number;
  readonly remotePort: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly userId: string;
  readonly signingKey: Uint8Array;
}

export type ResolveLiveDbConfigResult =
  | { readonly ok: true; readonly config: LiveDbConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

const REQUIRED = [
  "TEXCENTER_LIVE_DB_PASSWORD",
  "SESSION_SIGNING_KEY",
  "TEXCENTER_LIVE_USER_ID",
] as const;

export function resolveLiveDbConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolveLiveDbConfigResult {
  const missing: string[] = [];
  for (const key of REQUIRED) {
    const v = env[key];
    if (v === undefined || v === "") missing.push(key);
  }
  if (missing.length > 0) return { ok: false, missing };

  const password = env.TEXCENTER_LIVE_DB_PASSWORD as string;
  const rawKey = env.SESSION_SIGNING_KEY as string;
  if (!/^[A-Za-z0-9_-]+$/u.test(rawKey)) {
    throw new Error("SESSION_SIGNING_KEY is not valid base64url");
  }
  const signingKey = Buffer.from(rawKey, "base64url");
  if (signingKey.byteLength < 32) {
    throw new Error(
      `SESSION_SIGNING_KEY decodes to ${signingKey.byteLength} bytes; needs >=32`,
    );
  }

  const localPort = parsePort(env.TEXCENTER_LIVE_DB_LOCAL_PORT, 5433);
  const remotePort = parsePort(env.TEXCENTER_LIVE_DB_REMOTE_PORT, 5432);

  return {
    ok: true,
    config: {
      app: env.TEXCENTER_LIVE_DB_APP || "tex-center-db",
      localPort,
      remotePort,
      user: env.TEXCENTER_LIVE_DB_USER || "postgres",
      password,
      database: env.TEXCENTER_LIVE_DB_NAME || "postgres",
      userId: env.TEXCENTER_LIVE_USER_ID as string,
      signingKey: new Uint8Array(
        signingKey.buffer,
        signingKey.byteOffset,
        signingKey.byteLength,
      ),
    },
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port value: ${raw}`);
  }
  return n;
}

export function buildLiveDbUrl(config: LiveDbConfig): string {
  const u = encodeURIComponent(config.user);
  const p = encodeURIComponent(config.password);
  const db = encodeURIComponent(config.database);
  return `postgres://${u}:${p}@127.0.0.1:${config.localPort}/${db}`;
}

export interface BuildCookieSpecInput {
  /** Signed `tc_session` cookie value. */
  readonly value: string;
  /** Absolute expiry of the session row + token. */
  readonly expiresAt: Date;
  /** Host the cookie is scoped to, e.g. `tex.center`. */
  readonly host: string;
  /** Default `tc_session`. */
  readonly cookieName?: string;
  /** Default `true` (prod). Local-http tests can pass `false`. */
  readonly secure?: boolean;
}

export interface PlaywrightCookieSpec {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: "/";
  readonly expires: number;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "Lax";
}

export function buildSessionCookieSpec(
  input: BuildCookieSpecInput,
): PlaywrightCookieSpec {
  if (input.value === "") {
    throw new Error("buildSessionCookieSpec: empty cookie value");
  }
  if (input.host === "") {
    throw new Error("buildSessionCookieSpec: empty host");
  }
  return {
    name: input.cookieName ?? "tc_session",
    value: input.value,
    domain: input.host,
    path: "/",
    expires: Math.floor(input.expiresAt.getTime() / 1000),
    httpOnly: true,
    secure: input.secure ?? true,
    sameSite: "Lax",
  };
}
