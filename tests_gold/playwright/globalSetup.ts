// Playwright globalSetup. Single responsibility post-iter-303:
// bootstrap the shared live Fly project that the verifyLiveGt[1-5]
// specs / GT-7 / PdfNoFlash specs share.
//
// Per-worker local stack (PGlite + SvelteKit dev server) lives in
// `fixtures/localStack.ts` and is owned by the `db` worker fixture
// in `fixtures/authedPage.ts`. Each Playwright worker boots its own
// PGlite + dev server on its own ports, isolating local-target
// state across workers and avoiding the PGlite-over-TCP unnamed-
// prepared-statement collision that surfaced once workers > 1.
//
// If `FLY_API_TOKEN` / live DB creds are absent, the live
// bootstrap short-circuits and returns null; live specs gate
// themselves on those env vars and skip cleanly.

import {
  bootstrapLiveProject,
  exportProjectToEnv,
} from "./fixtures/liveProjectBootstrap.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
  let liveTeardown: (() => Promise<void>) | null = null;
  const live = await bootstrapLiveProject();
  if (live !== null) {
    exportProjectToEnv(live.project);
    liveTeardown = live.teardown;
  }

  return async () => {
    if (liveTeardown !== null) {
      try {
        await liveTeardown();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[globalSetup] live teardown failed:", err);
      }
    }
  };
}
