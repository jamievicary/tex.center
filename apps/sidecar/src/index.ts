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

export interface IdleHandlerContext {
  /** Called by the handler after a successful suspend→resume cycle
   *  so the server can re-arm its idle gate without waiting for a
   *  new viewer to come and go. */
  rearm: () => void;
}

export type IdleHandler = (ctx: IdleHandlerContext) => void;

// Idle handler. Two cases:
//
//   1. `suspendSelf` is wired (production on Fly with FLY_API_TOKEN).
//      The handler calls POST /machines/{self}/suspend. Fly sends the
//      response and *then* freezes the VM, so when the fetch promise
//      resolves we are post-resume — the Machine has been woken via
//      /start. The listener is still bound (we never close the app
//      here), so the incoming WS connection that triggered the
//      resume can be served. Re-arm the idle gate and stay alive.
//      Iter 249 incorrectly assumed the freeze happened mid-fetch
//      and called `exit(0)` after the await; that exited the sidecar
//      ~1 s after every resume, defeating the optimisation entirely
//      (live evidence: iter 255 log, reused-project Machine).
//
//      If the suspend call throws (Fly 5xx, bad token, network
//      blip), we do NOT close the app or exit. Exiting would park
//      the Machine in `stopped`, which is the 20 s+ cold-load path
//      the user reported (`260_answer.md`) and is M13.2(b).5's R2
//      target. Instead we log the failure and re-arm the idle gate
//      — a future inactive window retries. The cost of staying up
//      with a broken token is bounded (Fly bills sidecars at the
//      shared-pool rate); the cost of dropping into `stopped` is a
//      user-visible 20 s wait.
//
//   2. `suspendSelf` is null (local dev or missing creds). No
//      suspend API to call; close the app and exit cleanly. This is
//      the historical idle-stop path and the documented local-dev
//      contract.
export function createIdleHandler(deps: IdleHandlerDeps): IdleHandler {
  const log = deps.log ?? ((msg, err) => console.error(msg, err));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let inFlight = false;
  return (ctx: IdleHandlerContext): void => {
    if (inFlight) return;
    inFlight = true;
    void (async (): Promise<void> => {
      if (deps.suspendSelf) {
        try {
          await deps.suspendSelf();
        } catch (err) {
          log("sidecar idle: suspend failed, staying alive to retry next idle window", err);
        }
        // Whether suspend succeeded (post-resume) or threw (still
        // pre-suspend), the right move is the same: keep the
        // listener bound and re-arm the idle gate. Never exit from
        // this path — exit(0) is the route to `stopped`.
        inFlight = false;
        try {
          ctx.rearm();
        } catch (err) {
          log("sidecar idle: rearm callback threw", err);
        }
        return;
      }
      const app = deps.getApp();
      try {
        if (app) await app.close();
      } catch (err) {
        log("sidecar idle: app.close() failed", err);
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
