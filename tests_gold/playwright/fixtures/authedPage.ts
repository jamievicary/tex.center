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

import { randomUUID } from "node:crypto";

import { test as base, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import {
  createDb,
  closeDb,
  deleteSession,
  users,
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
        // Per-worker fly proxy port: base + workerIndex. Required
        // when workers > 1; harmless at workers=1 (workerIndex=0).
        // The bootstrap's own proxy uses a separate base
        // (TEXCENTER_GT_BOOTSTRAP_DB_LOCAL_PORT, default 5443) and
        // stays open for the suite lifetime.
        const localPort =
          resolved.config.localPort + workerInfo.workerIndex;
        const workerConfig = { ...resolved.config, localPort };
        const proxy = await startFlyProxy({
          app: workerConfig.app,
          localPort: workerConfig.localPort,
          remotePort: workerConfig.remotePort,
        });
        const db = createDb(buildLiveDbUrl(workerConfig));
        try {
          await use({
            db,
            signingKey: workerConfig.signingKey,
            userId: workerConfig.userId,
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
        // Per-worker user: each Playwright worker has its own user
        // row for the suite's lifetime, so concurrent specs cannot
        // collide on the seed user's project list (the empty-state
        // assertion in `projects.spec.ts` is the canonical example
        // — without per-worker isolation, worker A creating a
        // project in `editor.spec.ts` racing worker B's empty-state
        // check would fail the latter). The row is deleted on
        // worker teardown; FK cascade reaps any forgotten
        // afterEach state.
        const workerUserId = randomUUID();
        const workerEmail = `pw-worker-${workerInfo.workerIndex}-${workerUserId}@local.invalid`;
        const workerGoogleSub = `pw-worker-${workerUserId}`;
        await db.db.insert(users).values({
          id: workerUserId,
          email: workerEmail,
          googleSub: workerGoogleSub,
        });
        try {
          await use({
            db,
            signingKey: resolved.config.signingKey,
            userId: workerUserId,
          });
        } finally {
          await db.db
            .delete(users)
            .where(eq(users.id, workerUserId))
            .catch(() => {});
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
