// Worker-scoped fixture that creates ONE live Fly project +
// Machine and yields it to every spec in the worker. With
// `workers: 1`, this is effectively session-scoped: GT-A/B/C/D
// (the four `verifyLiveGt*.spec.ts` files) all share one
// project, paying the Fly Machine cold-start cost once instead
// of four times.
//
// The fixture is opt-in: only specs that import `test` from
// this module receive `liveProject`. Other live specs that need
// fresh projects (e.g. `verifyLiveFullPipeline.spec.ts`) keep
// using the base `authedPage` test and remain isolated.
//
// Teardown reaps the Machine + deletes the project row at
// worker shutdown. The count guardrail in
// `tests_gold/cases/test_sidecar_machine_count.py` will catch
// any teardown regression.
//
// Spec ordering: GT-A→B→C→D matters because B/C/D each leave
// the project in a more-mutated state than the previous test.
// File names are prefixed `verifyLiveGt[1-4]_*` so the
// Playwright runner picks them up in that order.

import { eq } from "drizzle-orm";

import {
  createProject,
  deleteSession,
  projects,
  type ProjectRow,
} from "@tex-center/db";

import {
  makeAssignmentStore,
  makeMachineDestroyer,
} from "./cleanupLiveProjectMachine.js";
import { cleanupProjectMachine } from "../../lib/src/cleanupProjectMachine.js";
import { mintSession } from "../../lib/src/mintSession.js";
import { buildSessionCookieSpec } from "../../lib/src/authedCookie.js";
import { TAG_PDF_SEGMENT } from "./wireFrames.js";
import { test as base } from "./authedPage.js";

interface Fixtures {
  liveProject: ProjectRow;
}

// Budget for the one-shot warm-up: cold Fly Machine boot + sidecar
// start + first lualatex round. Per `196_answer.md`: ~60-90s realistic,
// 180s gives safe headroom. If warm-up ever blows past ~120s that is
// its own (Fly/sidecar boot-time) regression signal.
const WARMUP_TIMEOUT_MS = 180_000;

export const test = base.extend<Record<string, never>, Fixtures>({
  liveProject: [
    async ({ db, browser }, use, workerInfo) => {
      if (workerInfo.project.name !== "live") {
        throw new Error(
          "sharedLiveProject is only valid against the `live` project. " +
            "Local-target specs should use the base authedPage test.",
        );
      }
      if (process.env.TEXCENTER_FULL_PIPELINE !== "1") {
        throw new Error(
          "sharedLiveProject requires TEXCENTER_FULL_PIPELINE=1.",
        );
      }

      const project = await createProject(db.db.db, {
        ownerId: db.userId,
        name: `pw-gt-shared-${Date.now()}`,
      });

      await warmUpProject({
        project,
        browser,
        db,
        baseURL: workerInfo.project.use.baseURL,
      });

      try {
        await use(project);
      } finally {
        const token = process.env.FLY_API_TOKEN ?? "";
        const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
        if (token !== "") {
          try {
            await cleanupProjectMachine({
              projectId: project.id,
              machines: makeMachineDestroyer({ token, appName }),
              assignments: makeAssignmentStore(db.db.db),
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("sharedLiveProject teardown failed:", err);
          }
        }
        await db.db.db
          .delete(projects)
          .where(eq(projects.id, project.id))
          .catch(() => {});
      }
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";

// Drive the freshly-created project's Fly Machine + sidecar through
// a full cold-start → initial pdf-segment so per-spec polls don't
// have to absorb cold-start tail. Per `196_question.md` /
// `196_answer.md`: "warm" means the same condition GT-3/5 open with
// — an initial `pdf-segment` frame observed on the project's WS.
// Anything weaker (only-handshake, only `compile-status running`)
// leaves the per-spec 5s initial polls exposed to a daemon-booted-
// but-no-frame-yet race.
//
// Elapsed wallclock is logged to stderr; treat blow-outs past
// ~120s as a Fly/sidecar boot regression rather than a per-spec
// issue.
async function warmUpProject(args: {
  project: ProjectRow;
  browser: import("@playwright/test").Browser;
  db: import("./authedPage.js").DbFixture;
  baseURL: string | undefined;
}): Promise<void> {
  const { project, browser, db, baseURL } = args;
  if (!baseURL) {
    throw new Error("sharedLiveProject: project has no baseURL for warm-up");
  }
  const host = new URL(baseURL).hostname;
  const minted = await mintSession({
    db: db.db.db,
    signingKey: db.signingKey,
    userId: db.userId,
  });
  const context = await browser.newContext();
  await context.addCookies([
    buildSessionCookieSpec({
      value: minted.cookieValue,
      expiresAt: minted.expiresAt,
      host,
      secure: host !== "127.0.0.1" && host !== "localhost",
    }),
  ]);
  const page = await context.newPage();
  const started = Date.now();
  try {
    let sawFrame = false;
    page.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${project.id}`)) return;
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) sawFrame = true;
      });
    });
    await page.goto(`/editor/${project.id}`);

    const deadline = started + WARMUP_TIMEOUT_MS;
    while (!sawFrame) {
      if (Date.now() > deadline) {
        throw new Error(
          `sharedLiveProject warm-up: no initial pdf-segment within ` +
            `${WARMUP_TIMEOUT_MS}ms for project ${project.id} ` +
            `(elapsed=${Date.now() - started}ms)`,
        );
      }
      await page.waitForTimeout(250);
    }
    // eslint-disable-next-line no-console
    console.warn(
      `sharedLiveProject warm-up: pdf-segment observed in ` +
        `${Date.now() - started}ms (project ${project.id})`,
    );
  } finally {
    await context.close().catch(() => {});
    await deleteSession(db.db.db, minted.sid).catch(() => {});
  }
}
