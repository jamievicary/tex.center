// Per-project sidecar entry point.
//
// `pnpm --filter @tex-center/sidecar dev` runs this via tsx; on
// production the same module is invoked after esbuild bundles it
// into a single ESM file inside the project Machine image (M7).

import { PROTOCOL_VERSION } from "@tex-center/protocol";

import { buildServer } from "./server.js";

export { buildServer } from "./server.js";

export function describe(): string {
  return `tex-center sidecar (protocol v${PROTOCOL_VERSION})`;
}

// Default WS bind address. `"::"` is the IPv6 dual-stack
// wildcard on Linux (Node binds v4 + v6), required for Fly 6PN
// which uses IPv6. `0.0.0.0` is IPv4-only and silently breaks
// the cross-Machine dial from the control plane (see
// deploy/INCIDENT-147.md).
export const DEFAULT_BIND_HOST = "::";

export function resolveBindHost(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env.HOST;
  if (raw === undefined || raw === "") return DEFAULT_BIND_HOST;
  return raw;
}

// M13.2(b): when the idle timer fires, ask Fly to *suspend* this
// Machine instead of letting it exit-and-destroy. A suspended
// Machine retains kernel/RAM state and resumes in ~300 ms vs.
// ~5–60 s for a cold image-pull. We call the public Machines API
// against ourselves via the FLY_API_TOKEN secret + the auto-
// injected FLY_APP_NAME / FLY_MACHINE_ID. The call freezes the VM
// mid-response in production; if it returns or errors, we fall
// back to `process.exit(0)` so the Machine still stops cleanly.
const MACHINES_API_BASE = "https://api.machines.dev/v1";

export type SuspendSelfFn = () => Promise<void>;

export function buildSuspendSelfFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SuspendSelfFn | null {
  const app = env.FLY_APP_NAME;
  const id = env.FLY_MACHINE_ID;
  const token = env.FLY_API_TOKEN;
  if (!app || !id || !token) return null;
  const url = `${MACHINES_API_BASE}/apps/${app}/machines/${id}/suspend`;
  return async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(`fly suspend failed: ${res.status} ${body}`);
    }
  };
}

export interface IdleHandlerDeps {
  getApp: () => { close(): Promise<void> } | null;
  suspendSelf: SuspendSelfFn | null;
  log?: (msg: string, err?: unknown) => void;
  exit?: (code: number) => never;
}

export function createIdleHandler(deps: IdleHandlerDeps): () => void {
  const log = deps.log ?? ((msg, err) => console.error(msg, err));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let fired = false;
  return (): void => {
    if (fired) return;
    fired = true;
    void (async (): Promise<void> => {
      const app = deps.getApp();
      try {
        if (app) await app.close();
      } catch (err) {
        log("sidecar idle: app.close() failed", err);
      }
      if (deps.suspendSelf) {
        try {
          await deps.suspendSelf();
          // In production the VM freezes mid-call and we never get
          // here. If we do (e.g. Fly returned success then resumed
          // us before the call site completed), exit cleanly.
          log("sidecar idle: suspend returned without freezing — exiting", null);
        } catch (err) {
          log("sidecar idle: suspend failed, falling back to clean exit", err);
        }
      }
      exit(0);
    })();
  };
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = resolveBindHost(process.env);
  // Idle-stop: 0 disables, anything >0 arms the timer. Default
  // 10 min matches the architecture note in GOAL.md.
  const idleRaw = process.env.SIDECAR_IDLE_TIMEOUT_MS;
  const idleTimeoutMs = idleRaw === undefined ? 600_000 : Number(idleRaw);
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  const onIdle = createIdleHandler({
    getApp: () => app,
    suspendSelf: buildSuspendSelfFromEnv(process.env),
  });
  app = await buildServer({
    logger: true,
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 0,
    onIdle,
  });
  await app.listen({ port, host });
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntry) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
