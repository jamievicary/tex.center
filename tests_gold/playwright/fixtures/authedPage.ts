// Playwright fixture: `authedPage` — a `Page` with a valid
// `tc_session` cookie attached, ready to hit authenticated
// routes on either the `local` or `live` target.
//
// Fixture hierarchy:
//
//   localStack (worker) — local target only. Boots a per-worker
//     PGlite + SvelteKit dev server (`./localStack.ts`) so workers
//     have no shared backend state. Production Postgres handles
//     concurrency fine but PGlite-over-TCP has a server-side
//     prepared-statement isolation bug that surfaces under
//     concurrent connections from multiple workers — per-worker
//     isolation sidesteps it.
//
//   baseURL (worker, overrides Playwright's built-in option) —
//     returns the live deploy URL, or the per-worker local dev
//     server URL (`3000 + workerIndex`). Used by Playwright to
//     resolve relative URLs in `page.goto`, and by `authedPage`
//     to scope the session cookie.
//
//   db (worker) — opens the right Drizzle handle for the
//     resolved project:
//       * `live` → flyctl proxy + live Postgres (per-worker
//         localPort = base + workerIndex).
//       * `local` → the worker's PGlite from `localStack`,
//         with a freshly-inserted per-worker user row (deleted
//         on worker teardown; FK cascade reaps forgotten
//         afterEach state).
//
//   authedPage (test) — mints a session row for `db.userId`,
//     attaches the cookie to a fresh context, yields the page,
//     and reaps the row on teardown.

import { randomUUID } from "node:crypto";

import {
  test as base,
  type Page,
  type PlaywrightTestOptions,
} from "@playwright/test";
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
} from "../../lib/src/authedCookie.js";
import {
  startFlyProxy,
  type FlyProxyHandle,
} from "../../lib/src/flyProxy.js";
import { startLocalStack, type LocalStack } from "./localStack.js";

export interface DbFixture {
  readonly db: DbHandle;
  readonly signingKey: Uint8Array;
  readonly userId: string;
  readonly proxy?: FlyProxyHandle;
}

interface WorkerFixtures {
  /** Per-worker local stack — null for live target. */
  localStack: LocalStack | null;
}

interface TestFixtures {
  db: DbFixture;
  authedPage: Page;
}

export const test = base.extend<
  TestFixtures & Pick<PlaywrightTestOptions, "baseURL">,
  WorkerFixtures
>({
  localStack: [
    async ({}, use, workerInfo) => {
      if (workerInfo.project.name === "live") {
        await use(null);
        return;
      }
      const stack = await startLocalStack({
        workerIndex: workerInfo.workerIndex,
      });
      try {
        await use(stack);
      } finally {
        await stack.close();
      }
    },
    { scope: "worker" },
  ],

  // `baseURL` is a Playwright-built-in test-scoped option, so this
  // override stays test-scoped (worker-scope override is rejected
  // by Playwright at fixture registration time). The value still
  // comes from the worker-scoped `localStack`, so it's effectively
  // constant per worker — just resolved on each test's setup path.
  baseURL: [
    async ({ localStack }, use, testInfo) => {
      if (testInfo.project.name === "live") {
        await use("https://tex.center");
      } else if (localStack !== null) {
        await use(localStack.baseURL);
      } else {
        await use(undefined);
      }
    },
    { option: true },
  ],

  db: [
    async ({ localStack }, use, workerInfo) => {
      const projectName = workerInfo.project.name;
      if (projectName === "live") {
        const resolved = resolveLiveDbConfig(process.env);
        if (!resolved.ok) {
          // Per `166_question.md`: live verification must fail loudly
          // when credentials are absent.
          throw new Error(
            `authedPage: missing required env for live: ${resolved.missing.join(", ")}`,
          );
        }
        // Per-worker fly proxy port: base + workerIndex. The
        // bootstrap's own proxy uses a separate base
        // (TEXCENTER_GT_BOOTSTRAP_DB_LOCAL_PORT, default 5443).
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
        if (localStack === null) {
          throw new Error("authedPage: localStack is null on a local worker");
        }
        const db = createDb(localStack.db.url, { onnotice: () => {} });
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
            signingKey: localStack.signingKey,
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

  authedPage: async ({ browser, db, baseURL }, use) => {
    if (!baseURL) {
      throw new Error("authedPage: baseURL fixture returned undefined");
    }
    const minted = await mintSession({
      db: db.db.db,
      signingKey: db.signingKey,
      userId: db.userId,
    });
    const context = await browser.newContext({ baseURL });
    const host = new URL(baseURL).hostname;
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
