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
  webServer:
    process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1"
      ? undefined
      : {
          // The `local` project owns the dev server. The `live`
          // project skips it by setting PLAYWRIGHT_SKIP_WEBSERVER=1
          // (see tests_gold/cases/test_playwright.py for the
          // gating logic). hooks.server.ts is deliberately resilient
          // to a missing SESSION_SIGNING_KEY (collapses to
          // anonymous), so the dev server can boot without any
          // OAuth/db secrets for the landing-page test.
          command: "pnpm --filter @tex-center/web dev --port " + LOCAL_PORT,
          url: `http://127.0.0.1:${LOCAL_PORT}/`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        },
});
