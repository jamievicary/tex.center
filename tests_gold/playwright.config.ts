import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// DrvFs (/mnt/c on WSL2) cannot reliably host Playwright's
// `test-results/` directory: between runs Playwright `rmdir`s the
// dir, which races with Windows file handles and fails with EACCES.
// Mirror the setup_playwright.sh symlink-to-ext4 pattern: when the
// checkout lives under /mnt/*, redirect outputDir to a cache dir
// under $HOME. Off DrvFs, use the in-repo default.
//
// Playwright loads this config in CJS mode (no `import.meta`), so
// derive the repo root from the test runner's cwd, which is always
// the checkout root (`tests_gold/cases/test_playwright.py` sets
// `cwd=ROOT`).
const REPO_ROOT = resolve(process.cwd());
function resolveOutputDir(): string {
  if (REPO_ROOT.startsWith("/mnt/")) {
    const hash = createHash("sha1")
      .update(REPO_ROOT)
      .digest("hex")
      .slice(0, 12);
    const cacheDir = join(
      homedir(),
      ".cache",
      "tex-center-pw-results",
      hash,
      "test-results",
    );
    mkdirSync(cacheDir, { recursive: true });
    return cacheDir;
  }
  return join(REPO_ROOT, "test-results");
}

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

// Per-test timeout budget. Must absorb the worker-scoped
// `sharedLiveProject` warm-up (WARMUP_TIMEOUT_MS = 180s — cold Fly
// Machine boot + sidecar start + first lualatex round) plus the
// first test's own work. The warm-up fixture setup happens lazily
// inside the FIRST test that requests `liveProject`, and
// `test.setTimeout(...)` inside a test body does NOT retroactively
// cover fixture setup that already ran. The default 30s is therefore
// not enough for that first spec — iter 206 GT-A failed exactly
// this way ("Test timeout of 30000ms exceeded while setting up
// 'liveProject'"). Local specs are unaffected: their own internal
// waitFor timeouts still bound them to their natural durations.
const TEST_TIMEOUT_MS = 240_000;

export default defineConfig({
  testDir: "./playwright",
  outputDir: resolveOutputDir(),
  globalSetup: "./playwright/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: TEST_TIMEOUT_MS,
  use: {
    trace: "off",
  },
  projects: [
    {
      name: "local",
      // `verifyLive*` specs only make sense against the live
      // deployment; skip them here entirely instead of running +
      // marking-skipped, which keeps the iter log clean.
      testIgnore: ["**/verifyLive*.spec.ts"],
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
