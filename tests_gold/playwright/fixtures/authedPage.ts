// Playwright fixture: `authedPage` — a `Page` with a valid
// `tc_session` cookie attached, ready to hit `live`-target
// authenticated routes.
//
// Composition: the worker-scoped `liveDb` fixture starts a
// `flyctl proxy` to `tex-center-db` and opens a Drizzle handle
// against it; the test-scoped `authedPage` fixture mints a
// session row for `TEXCENTER_LIVE_USER_ID`, sets the cookie on
// a fresh browser context, yields a page, and deletes the row
// on teardown.
//
// If any required env var is missing the fixture calls
// `test.skip` with the list of missing keys — so the default
// gold run (env-less) stays green and only the
// `TEXCENTER_LIVE_TESTS=1` invocations exercise this path.
//
// Required env:
//   - `TEXCENTER_LIVE_DB_PASSWORD` — `postgres` password on
//     `tex-center-db`.
//   - `SESSION_SIGNING_KEY` — same base64url HMAC key the live
//     web tier verifies cookies with.
//   - `TEXCENTER_LIVE_USER_ID` — `users.id` of an existing row
//     to mint the session for.
//
// Optional overrides: `TEXCENTER_LIVE_DB_APP` (default
// `tex-center-db`), `TEXCENTER_LIVE_DB_USER` (`postgres`),
// `TEXCENTER_LIVE_DB_NAME` (`postgres`), `TEXCENTER_LIVE_DB_LOCAL_PORT`
// (`5433`), `TEXCENTER_LIVE_DB_REMOTE_PORT` (`5432`).

import { test as base, type Page } from "@playwright/test";

import { createDb, closeDb, deleteSession, type DbHandle } from "@tex-center/db";

import { mintSession } from "../../lib/src/mintSession.js";
import {
  buildLiveDbUrl,
  buildSessionCookieSpec,
  resolveLiveDbConfig,
  type LiveDbConfig,
} from "../../lib/src/authedCookie.js";
import {
  startFlyProxy,
  type FlyProxyHandle,
} from "../../lib/src/flyProxy.js";

export interface LiveDbFixture {
  readonly config: LiveDbConfig;
  readonly db: DbHandle;
  readonly proxy: FlyProxyHandle;
}

interface Fixtures {
  liveDb: LiveDbFixture;
  authedPage: Page;
}

export const test = base.extend<Fixtures, Record<string, never>>({
  liveDb: [
    async ({}, use) => {
      const resolved = resolveLiveDbConfig(process.env);
      if (!resolved.ok) {
        test.skip(
          true,
          `authedPage: missing required env: ${resolved.missing.join(", ")}`,
        );
        return;
      }
      const proxy = await startFlyProxy({
        app: resolved.config.app,
        localPort: resolved.config.localPort,
        remotePort: resolved.config.remotePort,
      });
      const db = createDb(buildLiveDbUrl(resolved.config));
      try {
        await use({ config: resolved.config, db, proxy });
      } finally {
        await closeDb(db).catch(() => {});
        await proxy.close();
      }
    },
    { scope: "worker" },
  ],

  authedPage: async ({ browser, liveDb }, use, testInfo) => {
    const minted = await mintSession({
      db: liveDb.db.db,
      signingKey: liveDb.config.signingKey,
      userId: liveDb.config.userId,
    });
    const context = await browser.newContext();
    const host = hostFromBaseURL(testInfo.project.use.baseURL);
    await context.addCookies([
      buildSessionCookieSpec({
        value: minted.cookieValue,
        expiresAt: minted.expiresAt,
        host,
        secure: host !== "127.0.0.1" && host !== "localhost",
      }),
    ]);
    const page = await context.newPage();
    try {
      await use(page);
    } finally {
      await context.close().catch(() => {});
      await deleteSession(liveDb.db.db, minted.sid).catch(() => {});
    }
  },
});

export { expect } from "@playwright/test";

function hostFromBaseURL(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error("authedPage: project has no baseURL");
  }
  return new URL(baseURL).hostname;
}
