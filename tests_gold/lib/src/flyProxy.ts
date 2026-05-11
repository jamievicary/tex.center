// Spawn `flyctl proxy LOCAL:REMOTE -a APP` and resolve once the
// local port is accepting TCP connections. Used by Playwright
// `live`-target tests that need to read/write the production
// Postgres without baking flyctl invocation details into every
// fixture.
//
// Distinct failure modes — all observable to the caller:
//
//   - `flyctl` (or substitute command) exits before the port is
//     healthy → reject with the captured stderr + exit code.
//   - Port never opens within `readyTimeoutMs` → reject with a
//     timeout error that includes the bound port and elapsed ms.
//   - Spawn itself fails (`ENOENT`) → reject with the underlying
//     error.
//
// `close()` is idempotent and always settles: SIGTERM, wait up to
// `closeTimeoutMs`, then SIGKILL. The function does not leak the
// child on any code path.

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";

export interface FlyProxyInput {
  /** Fly app name, e.g. `tex-center-db`. */
  readonly app: string;
  /** Port on localhost the proxy binds. */
  readonly localPort: number;
  /** Remote port inside the Fly app. */
  readonly remotePort: number;
  /** Default `"flyctl"`. Tests override to a stand-in binary. */
  readonly command?: string;
  /** Extra args appended after the standard `flyctl proxy` args. */
  readonly extraArgs?: readonly string[];
  /** Max ms to wait for the port to accept connections. Default 15000. */
  readonly readyTimeoutMs?: number;
  /** Interval between port probes. Default 100ms. */
  readonly probeIntervalMs?: number;
  /** Max ms to wait after SIGTERM before SIGKILL. Default 2000. */
  readonly closeTimeoutMs?: number;
}

export interface FlyProxyHandle {
  readonly localPort: number;
  /** Idempotent; always resolves. */
  close(): Promise<void>;
}

export async function startFlyProxy(
  input: FlyProxyInput,
): Promise<FlyProxyHandle> {
  const command = input.command ?? "flyctl";
  const readyTimeoutMs = input.readyTimeoutMs ?? 15_000;
  const probeIntervalMs = input.probeIntervalMs ?? 100;
  const closeTimeoutMs = input.closeTimeoutMs ?? 2_000;

  const args = [
    "proxy",
    `${input.localPort}:${input.remotePort}`,
    "-a",
    input.app,
    ...(input.extraArgs ?? []),
  ];

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
  child.stdout?.on("data", () => {});

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve();
    });
  });

  let spawnError: Error | null = null;
  const spawnErrorPromise = new Promise<Error>((resolve) => {
    child.once("error", (err) => {
      spawnError = err;
      resolve(err);
    });
  });
  // Either an `exit` event or a fatal spawn `error` (ENOENT) means
  // the child is gone — close() must settle on either.
  const goneOrError = Promise.race([exitPromise, spawnErrorPromise]);

  const closed = { value: false };
  const handle: FlyProxyHandle = {
    localPort: input.localPort,
    async close() {
      if (closed.value) return;
      closed.value = true;
      if (exited || spawnError) return;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, closeTimeoutMs);
      try {
        await goneOrError;
      } finally {
        clearTimeout(killTimer);
      }
    },
  };

  try {
    await waitForReady(
      input.localPort,
      readyTimeoutMs,
      probeIntervalMs,
      () => exited,
      () => spawnError,
      () => Buffer.concat(stderrChunks).toString("utf8"),
    );
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

async function waitForReady(
  port: number,
  timeoutMs: number,
  intervalMs: number,
  exitedSnapshot: () => { code: number | null; signal: NodeJS.Signals | null } | null,
  spawnErrorSnapshot: () => Error | null,
  stderrSnapshot: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const se = spawnErrorSnapshot();
    if (se) {
      throw new Error(`startFlyProxy: spawn failed: ${se.message}`);
    }
    const ex = exitedSnapshot();
    if (ex) {
      const stderr = stderrSnapshot();
      throw new Error(
        `startFlyProxy: child exited before ready ` +
          `(code=${ex.code} signal=${ex.signal})\n` +
          `--- stderr ---\n${stderr}`,
      );
    }
    if (await tryConnect(port)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `startFlyProxy: port ${port} did not open within ` +
          `${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock: Socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
