// Per-worker local test stack: PGlite-over-TCP DB + SvelteKit dev
// server, each on its own ports. Used by the `db` worker fixture in
// `authedPage.ts`. Replaces the pre-iter-303 single-globalSetup
// arrangement.
//
// Why per-worker: PGlite's TCP socket wrapper has a server-side
// state-isolation bug under concurrent connections from multiple
// Playwright workers — the unnamed-prepared-statement state leaks
// across connections, producing "bind supplies N parameters,
// prepared statement requires M" errors mid-test. Production
// Postgres has no such bug; this is purely a test-harness quirk
// of PGlite-over-TCP. Each Playwright worker now boots its own
// PGlite + its own dev server, so there's no shared backend
// state. Costs ~1 PGlite spawn (~200 ms) and ~1 SvelteKit/Vite
// startup (~3-8 s with on-disk cache warm) per worker; both run
// in parallel across workers so wallclock impact is the single-
// worker setup time, not N×.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Readable } from "node:stream";

import { startLocalDb, type LocalDb } from "../../lib/src/localDb.js";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "db",
  "src",
  "migrations",
);

// Worker 0 picks BASE_PORT, worker 1 picks BASE_PORT+1, etc. 3000
// stays at index 0 for backward compatibility with any tooling that
// still expects the dev server on the classic port.
const BASE_DEV_PORT = 3000;
const DEV_READY_TIMEOUT_MS = 120_000;

export interface LocalStack {
  readonly baseURL: string;
  readonly db: LocalDb;
  readonly signingKey: Uint8Array;
  readonly userId: string;
  close: () => Promise<void>;
}

type DevChild = ChildProcessByStdio<null, Readable, Readable>;

export async function startLocalStack({
  workerIndex,
}: {
  readonly workerIndex: number;
}): Promise<LocalStack> {
  const db = await startLocalDb({ migrationsDir: MIGRATIONS_DIR });
  const signingKeyBase64 = Buffer.from(db.signingKey).toString("base64url");
  const port = BASE_DEV_PORT + workerIndex;

  let devServer: DevChild;
  try {
    devServer = await spawnDevServer({
      port,
      timeoutMs: DEV_READY_TIMEOUT_MS,
      databaseUrl: db.url,
      signingKeyBase64,
    });
  } catch (err) {
    await db.close();
    throw err;
  }

  return {
    baseURL: `http://127.0.0.1:${port}`,
    db,
    signingKey: db.signingKey,
    userId: db.userId,
    async close() {
      await killChild(devServer);
      await db.close();
    },
  };
}

async function spawnDevServer({
  port,
  timeoutMs,
  databaseUrl,
  signingKeyBase64,
}: {
  readonly port: number;
  readonly timeoutMs: number;
  readonly databaseUrl: string;
  readonly signingKeyBase64: string;
}): Promise<DevChild> {
  if (await isPortInUse(port)) {
    await tryFreePort(port);
    if (await isPortInUse(port)) {
      throw new Error(
        `localStack: port ${port} is already in use and self-heal could not free it. ` +
          `Identify and kill it (e.g. \`ss -tlnp | grep ${port}\`).`,
      );
    }
  }

  const child = spawn(
    "pnpm",
    ["--filter", "@tex-center/web", "dev", "--port", String(port)],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SESSION_SIGNING_KEY: signingKeyBase64,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  ) as DevChild;

  child.stdout.on("data", () => {});
  child.stderr.on("data", (b) => process.stderr.write(`[dev:${port}] ${b}`));

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `dev server :${port} exited early (code=${exited.code}, signal=${exited.signal}) before becoming ready`,
      );
    }
    try {
      const r = await fetch(baseUrl);
      if (r.status > 0 && r.status < 500) return child;
    } catch {
      // Connection refused while Vite is still booting; retry.
    }
    await wait(200);
  }
  await killChild(child);
  throw new Error(
    `dev server :${port} did not become ready at ${baseUrl} within ${timeoutMs}ms`,
  );
}

async function killChild(child: DevChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
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

async function tryFreePort(port: number): Promise<void> {
  const pids = listenerPids(port);
  if (pids.length === 0) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[localStack] self-heal: killing stale port ${port} listener(s): ${pids.join(", ")}`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone; fine.
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return;
    await wait(100);
  }
  for (const pid of listenerPids(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await wait(200);
}

function listenerPids(port: number): number[] {
  try {
    const out = execFileSync("ss", ["-lntpH", `sport = :${port}`], {
      encoding: "utf8",
    });
    const pids = new Set<number>();
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      pids.add(parseInt(m[1]!, 10));
    }
    return [...pids];
  } catch {
    return [];
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
