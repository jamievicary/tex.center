// Playwright fixture: `authedPage` — a `Page` with a valid
// `tc_session` cookie attached, ready to hit authenticated
// routes on either the `local` or `live` target.
//
// Composition:
//   - The worker-scoped `db` fixture resolves the right
//     transport for the active project:
//       * `live` → start `flyctl proxy` to `tex-center-db`,
//         open a Drizzle handle against `127.0.0.1:LOCAL_PORT`,
//         read signing key + user id from env.
//       * `local` → read `DATABASE_URL`, `SESSION_SIGNING_KEY`,
//         and `TEXCENTER_LOCAL_USER_ID` from env (set by
//         `globalSetup.ts` which boots an in-process PGlite-
//         over-TCP server), open a Drizzle handle to that URL.
//   - The test-scoped `authedPage` fixture mints a session
//     row for the resolved user id, sets the cookie on a fresh
//     browser context, yields a `Page`, and deletes the row on
//     teardown.
//
// If a target's required env is missing the worker fixture
// calls `test.skip` with the list of missing keys, so the
// default gold run stays green and only the appropriate
// invocation exercises this path.
//
// Required env (`live` target):
//   - `TEXCENTER_LIVE_DB_PASSWORD`, `SESSION_SIGNING_KEY`,
//     `TEXCENTER_LIVE_USER_ID`. Optional overrides per
//     `resolveLiveDbConfig` in `authedCookie.ts`.
//
// Required env (`local` target): set by `globalSetup.ts`
// automatically; absent only if `globalSetup` was skipped.

import { test as base, type Page } from "@playwright/test";

import {
  createDb,
  closeDb,
  deleteSession,
  type DbHandle,
} from "@tex-center/db";

import { mintSession } from "../../lib/src/mintSession.js";
import {
  buildLiveDbUrl,
  buildSessionCookieSpec,
  resolveLiveDbConfig,
  resolveLocalDbEnv,
} from "../../lib/src/authedCookie.js";
import {
  startFlyProxy,
  type FlyProxyHandle,
} from "../../lib/src/flyProxy.js";

export interface DbFixture {
  readonly db: DbHandle;
  readonly signingKey: Uint8Array;
  readonly userId: string;
  readonly proxy?: FlyProxyHandle;
}

interface Fixtures {
  db: DbFixture;
  authedPage: Page;
}

export const test = base.extend<Fixtures, Record<string, never>>({
  db: [
    async ({}, use, workerInfo) => {
      const projectName = workerInfo.project.name;
      if (projectName === "live") {
        const resolved = resolveLiveDbConfig(process.env);
        if (!resolved.ok) {
          // Per `166_question.md`: live verification must fail loudly
          // when credentials are absent, not skip silently. The
          // tests_gold Python runner is the canonical entry point and
          // populates these from `creds/`; if we reach this branch
          // it means the spec was invoked directly with an incomplete
          // env, which is still a real configuration breakage worth
          // surfacing.
          throw new Error(
            `authedPage: missing required env for live: ${resolved.missing.join(", ")}`,
          );
        }
        const proxy = await startFlyProxy({
          app: resolved.config.app,
          localPort: resolved.config.localPort,
          remotePort: resolved.config.remotePort,
        });
        const db = createDb(buildLiveDbUrl(resolved.config));
        try {
          await use({
            db,
            signingKey: resolved.config.signingKey,
            userId: resolved.config.userId,
            proxy,
          });
        } finally {
          await closeDb(db).catch(() => {});
          await proxy.close();
        }
      } else {
        const resolved = resolveLocalDbEnv(process.env);
        if (!resolved.ok) {
          test.skip(
            true,
            `authedPage: missing required env for local: ${resolved.missing.join(", ")} (globalSetup may have been skipped)`,
          );
          return;
        }
        const db = createDb(resolved.config.url, { onnotice: () => {} });
        try {
          await use({
            db,
            signingKey: resolved.config.signingKey,
            userId: resolved.config.userId,
          });
        } finally {
          await closeDb(db).catch(() => {});
        }
      }
    },
    { scope: "worker" },
  ],

  authedPage: async ({ browser, db }, use, testInfo) => {
    const minted = await mintSession({
      db: db.db.db,
      signingKey: db.signingKey,
      userId: db.userId,
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
      await deleteSession(db.db.db, minted.sid).catch(() => {});
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
