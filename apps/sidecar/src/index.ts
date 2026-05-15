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

export interface IdleHandlerContext {
  /** Re-arm the idle gate for another window (called by the suspend
   *  handler after a successful suspend→resume cycle, or after a
   *  best-effort suspend failure, so the server doesn't need a new
   *  viewer-toggle to retry). */
  rearm: () => void;
}

export type IdleHandler = (ctx: IdleHandlerContext) => void;

export interface SuspendHandlerDeps {
  suspendSelf: SuspendSelfFn | null;
  log?: (msg: string, err?: unknown) => void;
}

// M20.1 suspend stage. Fires at the short timeout (default 5 s in
// `main()`); best-effort POST /suspend then re-arm.
//
//   1. `suspendSelf` is wired (production on Fly with FLY_API_TOKEN).
//      Calls POST /machines/{self}/suspend. Fly sends the response
//      and *then* freezes the VM, so when the fetch promise resolves
//      we are post-resume — the Machine has been woken via /start.
//      The listener is still bound (the suspend handler NEVER closes
//      the app), so the incoming WS connection that triggered the
//      resume can be served. Re-arm and stay alive.
//      Iter 249 incorrectly assumed the freeze happened mid-fetch
//      and called `exit(0)` after the await; that exited the sidecar
//      ~1 s after every resume, defeating the optimisation entirely
//      (live evidence: iter 255 log, reused-project Machine).
//
//      If the suspend call throws (Fly 5xx, bad token, network
//      blip), we do NOT close the app or exit. Exiting would park
//      the Machine in `stopped` eagerly, which was the failure mode
//      iter 267 (R2) closed. Stop is the *stop stage's* job, on its
//      own (longer) timer; the suspend stage stays soft.
//
//   2. `suspendSelf` is null (local dev or missing creds). No
//      suspend API to call; log a one-time-per-fire warning and
//      re-arm. The stop stage (separate timer) handles the eventual
//      exit on local dev.
export function createSuspendHandler(deps: SuspendHandlerDeps): IdleHandler {
  const log = deps.log ?? ((msg, err) => console.error(msg, err));
  let inFlight = false;
  return (ctx: IdleHandlerContext): void => {
    if (inFlight) return;
    inFlight = true;
    void (async (): Promise<void> => {
      if (deps.suspendSelf) {
        try {
          await deps.suspendSelf();
        } catch (err) {
          log("sidecar suspend: failed, staying alive to retry next idle window", err);
        }
      } else {
        log("sidecar suspend: no suspendSelf wired; stop stage will handle eventual exit", undefined);
      }
      inFlight = false;
      try {
        ctx.rearm();
      } catch (err) {
        log("sidecar suspend: rearm callback threw", err);
      }
    })();
  };
}

export interface StopHandlerDeps {
  getApp: () => { close(): Promise<void> } | null;
  log?: (msg: string, err?: unknown) => void;
  exit?: (code: number) => never;
}

// M20.1 stop stage. Fires at the long timeout (default 300 s); the
// failsafe cold-storage path. Closes the listener and exits cleanly
// so Fly's `restart: on-failure` parks the Machine in `stopped`.
export function createStopHandler(deps: StopHandlerDeps): IdleHandler {
  const log = deps.log ?? ((msg, err) => console.error(msg, err));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let inFlight = false;
  return (_ctx: IdleHandlerContext): void => {
    if (inFlight) return;
    inFlight = true;
    void (async (): Promise<void> => {
      const app = deps.getApp();
      try {
        if (app) await app.close();
      } catch (err) {
        log("sidecar stop: app.close() failed", err);
      }
      exit(0);
    })();
  };
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = resolveBindHost(process.env);
  // M20.1 two-stage idle cascade.
  //   SIDECAR_SUSPEND_MS: best-effort Fly suspend (RAM freeze). 0 disables.
  //   SIDECAR_STOP_MS:    cold-storage failsafe (exit 0). 0 disables.
  const suspendRaw = process.env.SIDECAR_SUSPEND_MS;
  const suspendTimeoutMs = suspendRaw === undefined ? 5_000 : Number(suspendRaw);
  const stopRaw = process.env.SIDECAR_STOP_MS;
  const stopTimeoutMs = stopRaw === undefined ? 300_000 : Number(stopRaw);
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  const onSuspend = createSuspendHandler({
    suspendSelf: buildSuspendSelfFromEnv(process.env),
  });
  const onStop = createStopHandler({
    getApp: () => app,
  });
  app = await buildServer({
    logger: true,
    suspendTimeoutMs: Number.isFinite(suspendTimeoutMs) ? suspendTimeoutMs : 0,
    onSuspend,
    stopTimeoutMs: Number.isFinite(stopTimeoutMs) ? stopTimeoutMs : 0,
    onStop,
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
