import { defineConfig, devices } from "@playwright/test";

// Two projects:
//   local — boots `pnpm --filter @tex-center/web dev` via webServer.
//           Used by ordinary iterations.
//   live  — targets the production deployment at https://tex.center.
//           Used by deploy-touching iterations (gated on
//           TEXCENTER_LIVE_TESTS=1 in the gold runner).
//
// All browser tests live under `tests_gold/playwright/` and share
// these configs. Per-test target is selected with
// `--project=<name>`.

const LOCAL_PORT = 3000;

export default defineConfig({
  testDir: "./playwright",
  globalSetup: "./playwright/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "off",
  },
  projects: [
    {
      name: "local",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${LOCAL_PORT}`,
      },
    },
    {
      name: "live",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "https://tex.center",
      },
    },
  ],
  // The dev server is intentionally NOT configured via Playwright's
  // top-level `webServer` block: the runner starts `webServer`
  // before `globalSetup`, so env vars `globalSetup` exports
  // (`DATABASE_URL`, `SESSION_SIGNING_KEY`) would never reach the
  // dev server. `globalSetup.ts` spawns it manually after the
  // PGlite-over-TCP boot, in the correct order.
});
