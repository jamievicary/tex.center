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
  projects,
  type ProjectRow,
} from "@tex-center/db";

import {
  makeAssignmentStore,
  makeMachineDestroyer,
} from "./cleanupLiveProjectMachine.js";
import { cleanupProjectMachine } from "../../lib/src/cleanupProjectMachine.js";
import { test as base } from "./authedPage.js";

interface Fixtures {
  liveProject: ProjectRow;
}

export const test = base.extend<Record<string, never>, Fixtures>({
  liveProject: [
    async ({ db }, use, workerInfo) => {
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
