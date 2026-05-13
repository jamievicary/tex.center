// Test-scoped fixture that exposes the live `ProjectRow` created
// + warmed up by `globalSetup.ts` (see
// `fixtures/liveProjectBootstrap.ts`).
//
// Previous incarnation (pre-iter-210) was a worker-scoped fixture
// that *created* the project and ran a Chromium warm-up inline.
// That coupled Playwright's per-test `timeout` to the cold-start
// warm-up duration (worker-scoped fixture setup runs lazily inside
// the first requesting test, and `test.setTimeout()` cannot
// retroactively cover setup already in progress). The result was
// a 240s global timeout where the only diagnostic content was
// "something between 0 and 4 minutes happened" — see
// `.autodev/discussion/207_answer.md`.
//
// Bootstrap now lives in `globalSetup.ts`, outside the per-test
// budget. This fixture just reads the resulting project info from
// env. Teardown lives in the globalSetup returned closure.
//
// Spec ordering: GT-A→B→C→D→5 matters because each leaves the
// project in a more-mutated state than the previous test. File
// names are prefixed `verifyLiveGt[1-5]_*` so the Playwright
// runner picks them up in that order.

import type { ProjectRow } from "@tex-center/db";

import { readProjectFromEnv } from "./liveProjectBootstrap.js";
import { test as base } from "./authedPage.js";

interface Fixtures {
  liveProject: ProjectRow;
}

export const test = base.extend<Fixtures, Record<string, never>>({
  liveProject: async ({}, use, testInfo) => {
    if (testInfo.project.name !== "live") {
      throw new Error(
        "liveProject is only valid against the `live` project. " +
          "Local-target specs should use the base authedPage test.",
      );
    }
    if (process.env.TEXCENTER_FULL_PIPELINE !== "1") {
      throw new Error(
        "liveProject requires TEXCENTER_FULL_PIPELINE=1.",
      );
    }
    const project = readProjectFromEnv();
    if (project === null) {
      throw new Error(
        "liveProject: globalSetup did not export project env vars. " +
          "This usually means FLY_API_TOKEN or live DB creds were " +
          "missing when globalSetup ran.",
      );
    }
    await use(project);
  },
});

export { expect } from "@playwright/test";
