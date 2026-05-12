// Playwright globalSetup for the `local` target.
//
// Two responsibilities, in order:
//
//  1. Boot a PGlite-over-TCP DB (`startLocalDb`), and export
//     `DATABASE_URL`, `SESSION_SIGNING_KEY`,
//     `TEXCENTER_LOCAL_USER_ID` to `process.env`. The
//     `authedPage` fixture reads these in the worker to mint
//     sessions for the seeded user.
//
//  2. Spawn the SvelteKit dev server ourselves, AFTER step 1,
//     so the env we just set actually reaches the child. We
//     deliberately do not use Playwright's top-level
//     `webServer` config: the runner starts `webServer` before
//     `globalSetup` (`tasks.js` orders pluginSetup → globalSetup),
//     which would race — the dev server would inherit a
//     pre-globalSetup env (no DATABASE_URL), `getDb()` would
//     throw on first session lookup, and authed redirects
//     would silently collapse to anonymous. Owning the spawn
//     here makes the ordering explicit.
//
// Returns a teardown closure (Playwright's recommended pattern)
// that kills the dev server and stops the PGlite server.
//
// Unconditional: we always boot pglite + the SvelteKit dev
// server because tests_gold runs both `local` and `live`
// projects in one Playwright invocation. The live specs don't
// dial localhost, so the running dev server is harmless to
// them; booting once amortises the cost across all specs.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Readable } from "node:stream";

import { startLocalDb, type LocalDb } from "../lib/src/localDb.js";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "packages",
  "db",
  "src",
  "migrations",
);

const DEV_PORT = 3000;
const READY_TIMEOUT_MS = 120_000;

export default async function globalSetup(): Promise<() => Promise<void>> {
  const local: LocalDb = await startLocalDb({
    migrationsDir: MIGRATIONS_DIR,
  });
  const localSigningKey = Buffer.from(local.signingKey).toString("base64url");
  // Local-only env: read by `resolveLocalDbEnv` so the local
  // worker mints cookies with the pglite-generated signing key.
  // Do NOT overwrite `SESSION_SIGNING_KEY` in this process — the
  // live worker needs that env var to hold the live Fly secret
  // (loaded from `creds/` by `test_playwright.py`). Clobbering
  // it caused live-cookie verification to fail server-side: the
  // signed token never verified, sessionHook returned `bad-token`,
  // every live spec saw `302 / + clearCookie`.
  process.env.DATABASE_URL = local.url;
  process.env.TEXCENTER_LOCAL_SIGNING_KEY = localSigningKey;
  process.env.TEXCENTER_LOCAL_USER_ID = local.userId;
  // eslint-disable-next-line no-console
  console.log(
    `[globalSetup] DB ready (userId=${local.userId}); spawning dev server on :${DEV_PORT}`,
  );

  const child = await spawnDevServer(DEV_PORT, READY_TIMEOUT_MS, localSigningKey);

  return async () => {
    await killChild(child);
    await local.close();
  };
}

type DevChild = ChildProcessByStdio<null, Readable, Readable>;

async function spawnDevServer(
  port: number,
  timeoutMs: number,
  localSigningKey: string,
): Promise<DevChild> {
  if (await isPortInUse(port)) {
    throw new Error(
      `globalSetup: port ${port} is already in use. A previous dev server likely leaked. ` +
        `Identify and kill it (e.g. \`ss -tlnp | grep ${port}\`) before retrying.`,
    );
  }
  const child = spawn(
    "pnpm",
    ["--filter", "@tex-center/web", "dev", "--port", String(port)],
    {
      // Inject the local signing key into the dev server's env
      // (which the SvelteKit hook reads as `SESSION_SIGNING_KEY`)
      // without touching the parent's `process.env` — see the
      // comment on `localSigningKey` above for why that matters.
      env: { ...process.env, SESSION_SIGNING_KEY: localSigningKey },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  ) as DevChild;
  // Forward stderr so failures surface in the Playwright log;
  // stdout is silenced because the dev DB connection emits noisy
  // postgres NOTICE/DEBUG messages on every request that drown
  // out test output.
  child.stdout.on("data", () => {});
  child.stderr.on("data", (b) => process.stderr.write(`[dev] ${b}`));

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `dev server exited early (code=${exited.code}, signal=${exited.signal}) before becoming ready`,
      );
    }
    try {
      const r = await fetch(baseUrl);
      if (r.status > 0 && r.status < 500) {
        return child;
      }
    } catch {
      // Connection refused while Vite is still booting; retry.
    }
    await wait(200);
  }
  await killChild(child);
  throw new Error(
    `dev server did not become ready at ${baseUrl} within ${timeoutMs}ms`,
  );
}

async function killChild(child: DevChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  // `detached: true` placed the child in its own process group;
  // signal the whole group so vite (a grandchild of pnpm) dies
  // with the parent.
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Group already gone — fall through to direct kill.
      child.kill("SIGTERM");
    }
  }
  const result = await Promise.race([
    exited.then(() => "exited" as const),
    wait(5000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await exited;
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      resolve(false);
    });
  });
}
