// Per-project upstream resolver (M7.1.2).
//
// Given a projectId, return the 6PN address of that project's
// sidecar Fly Machine. Creates a Machine on first use, starts one
// that's stopped, waits out a transient lifecycle state. The
// resolver is consulted by the WS proxy on every authorised
// upgrade and runs *after* the auth gate so unauthenticated
// callers never trigger a Machines API call.
//
// State table (Fly states from `flyMachines.ts:MachineState`):
//
//   started                       → use as-is
//   created | starting            → waitForState('started')
//   stopped | suspended           → start, waitForState('started')
//   stopping | suspending         → wait until quiescent, then start
//   destroying | destroyed | replacing
//                                 → row is stale, drop it and recreate
//
// In-process concurrency: two upgrades for the same project that
// arrive simultaneously must share a single create/start round-
// trip. A per-projectId promise cache dedupes in-flight calls; the
// entry is cleared on settle.

import net from "node:net";

import { errorMessage } from "../errors.js";

import {
  deleteMachineAssignment,
  getMachineAssignmentByProjectId,
  updateMachineAssignmentState,
  upsertMachineAssignment,
  type DrizzleDb,
} from "@tex-center/db";

import type {
  Machine,
  MachineConfig,
  MachineState,
  MachinesClient,
} from "./flyMachines.js";
import type { SidecarUpstream } from "./wsProxy.js";

export type UpstreamResolver = (
  projectId: string,
) => Promise<SidecarUpstream>;

// Narrow union recorded in `machine_assignments.state`. Wider Fly
// states normalise to one of these three at the cache boundary.
export type CachedState = "starting" | "running" | "stopped";

export function cachedStateOf(s: MachineState): CachedState {
  if (s === "started") return "running";
  if (s === "stopped" || s === "suspended") return "stopped";
  return "starting";
}

export interface MachineAssignmentStore {
  get(projectId: string): Promise<
    | { machineId: string; region: string; state: CachedState }
    | null
  >;
  upsert(input: {
    projectId: string;
    machineId: string;
    region: string;
    state: CachedState;
  }): Promise<void>;
  updateState(projectId: string, state: CachedState): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface UpstreamResolverOptions {
  readonly machines: MachinesClient;
  readonly store: MachineAssignmentStore;
  readonly sidecarPort: number;
  readonly sidecarRegion: string;
  readonly machineConfig: MachineConfig;
  /** API-side `waitForState` timeout (seconds). Defaults to 60. */
  readonly waitTimeoutSec?: number;
  /**
   * Overall deadline for driving a Machine to `started`, in
   * seconds. Defaults to 300. The Fly Machines `/wait` endpoint
   * caps `timeoutSec` at 60, but a cold-start image pull can take
   * 1m30s+ (observed live, iter 164). When `/wait` returns 408,
   * we re-poll until this overall deadline elapses. The single API
   * call still uses `waitTimeoutSec`.
   */
  readonly coldStartTimeoutSec?: number;
  /**
   * Probe the upstream's TCP port after Fly reports the Machine as
   * `started`, retrying until it accepts a connection or
   * `tcpProbeTimeoutSec` elapses. Closes the gap between Fly's
   * Machine-state transition and the sidecar process actually
   * binding to its listen port (observed live, iter 168: dial races
   * the sidecar's bind by 100s of ms and gets ECONNREFUSED). The
   * function must resolve on a successful TCP connect and reject on
   * any error; the resolver retries on rejection.
   *
   * Defaults to a `net.connect`-based probe. Tests inject a stub
   * (or a no-op for cases that don't exercise the probe path).
   */
  readonly tcpProbe?: (host: string, port: number) => Promise<void>;
  /**
   * Bound on the post-`started` TCP-readiness probe loop, in
   * seconds. Defaults to 60. Independent of `coldStartTimeoutSec`
   * because the API-side wait and the port-readiness wait are
   * different timing populations.
   */
  readonly tcpProbeTimeoutSec?: number;
  /**
   * Bound on the 412-retry loop wrapping `startMachine`, in
   * seconds. Defaults to 10. Fly's `POST /machines/{id}/stop` is
   * asynchronous: the API can report `state=stopped` before the
   * runtime has finished tearing down, and a subsequent
   * `startMachine` within the gap returns
   * `412 failed_precondition: machine still active, refusing to
   * start`. The wrapper retries 412 (only) with 250 ms backoff
   * until this budget elapses. Observed gap ≤8 s in production
   * (iter 376 GT-6-stopped trace); 10 s leaves headroom.
   */
  readonly startMachineRetryTimeoutSec?: number;
  /**
   * M15 Step D: optional seed-doc lookup. Called exactly once,
   * during the first `createMachine` for a project (no existing
   * assignment). When it resolves non-null, the per-project
   * Machine is created with `SEED_MAIN_DOC_B64=<base64(seed)>` in
   * its env, and the sidecar uses those bytes for `main.tex` on
   * first hydration in place of `MAIN_DOC_HELLO_WORLD`. Any
   * exception is logged via `onResolveError` (if provided) and
   * treated as "no seed" — a seed-lookup transient must not
   * block the editor from opening.
   */
  readonly seedDocFor?: (projectId: string) => Promise<string | null>;
  /**
   * Reporter for `seedDocFor` failures. Receives `{ projectId,
   * message }`. Defaults to a console.error; pass `() => {}` to
   * silence in tests.
   */
  readonly onSeedDocError?: (detail: {
    projectId: string;
    message: string;
  }) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function defaultTcpProbe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const cleanup = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // socket may already be torn down
      }
      fn();
    };
    socket.once("connect", () => cleanup(() => resolve()));
    socket.once("error", (err) => cleanup(() => reject(err)));
  });
}

const TERMINAL_STATES: ReadonlySet<MachineState> = new Set([
  "destroying",
  "destroyed",
  "replacing",
]);

export function createUpstreamResolver(
  opts: UpstreamResolverOptions,
): UpstreamResolver {
  const inFlight = new Map<string, Promise<SidecarUpstream>>();

  const resolveOnce = async (projectId: string): Promise<SidecarUpstream> => {
    let machineId = await ensureMachineId(projectId);
    let machine = await opts.machines.getMachine(machineId);

    if (TERMINAL_STATES.has(machine.state)) {
      // The cached row points at a Machine Fly is tearing down (or
      // already destroyed). Drop it and recreate.
      await opts.store.delete(projectId);
      machineId = await ensureMachineId(projectId);
      machine = await opts.machines.getMachine(machineId);
    }

    machine = await driveToStarted(machineId, machine);
    await opts.store.updateState(projectId, "running");

    const upstream = {
      host: opts.machines.internalAddress(machineId),
      port: opts.sidecarPort,
    };
    await waitForUpstreamReady(upstream);
    return upstream;
  };

  const waitForUpstreamReady = async (
    upstream: SidecarUpstream,
  ): Promise<void> => {
    const probe = opts.tcpProbe ?? defaultTcpProbe;
    const deadline = Date.now() + (opts.tcpProbeTimeoutSec ?? 60) * 1000;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        await probe(upstream.host, upstream.port);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    throw new Error(
      `upstreamResolver: ${upstream.host}:${upstream.port} did not accept TCP within probe budget: ${errorMessage(lastErr)}`,
    );
  };

  const ensureMachineId = async (projectId: string): Promise<string> => {
    const cached = await opts.store.get(projectId);
    if (cached !== null) return cached.machineId;
    // Tag every per-project Machine with `texcenter_project=<id>` so
    // the gold-suite leak guardrail
    // (`test_machine_count_under_threshold`) can programmatically
    // distinguish per-project sidecars from the `app`-tagged shared
    // pool, and so future iterations' delete-project verb can
    // destroy by tag without consulting the assignments table.
    const baseMetadata =
      (opts.machineConfig.metadata as Record<string, string> | undefined) ?? {};
    // M15 Step D: bake the seed (if any) into Machine env at
    // creation time. Env vars on Fly Machines are immutable for the
    // Machine's life, which is fine here — the sidecar only
    // consults the seed when no `main.tex` blob exists, so once
    // hydrated the env is moot. A `seedDocFor` throw is best-effort:
    // log and proceed without the seed rather than blocking the
    // upgrade.
    let seedEnv: Record<string, string> | null = null;
    if (opts.seedDocFor !== undefined) {
      try {
        const seed = await opts.seedDocFor(projectId);
        if (seed !== null && seed.length > 0) {
          seedEnv = {
            SEED_MAIN_DOC_B64: Buffer.from(seed, "utf8").toString("base64"),
          };
        }
      } catch (err) {
        opts.onSeedDocError?.({ projectId, message: errorMessage(err) });
      }
    }
    const baseEnv =
      (opts.machineConfig.env as Record<string, string> | undefined) ?? {};
    const config: MachineConfig = {
      ...opts.machineConfig,
      metadata: { ...baseMetadata, texcenter_project: projectId },
      ...(seedEnv !== null ? { env: { ...baseEnv, ...seedEnv } } : {}),
    };
    const created = await opts.machines.createMachine({
      region: opts.sidecarRegion,
      config,
    });
    await opts.store.upsert({
      projectId,
      machineId: created.id,
      region: created.region ?? opts.sidecarRegion,
      state: cachedStateOf(created.state),
    });
    return created.id;
  };

  const waitForStartedWithRetry = async (machineId: string): Promise<void> => {
    const apiCallTimeoutSec = opts.waitTimeoutSec ?? 60;
    const coldStartDeadline =
      Date.now() + (opts.coldStartTimeoutSec ?? 300) * 1000;
    while (true) {
      try {
        await opts.machines.waitForState(machineId, "started", {
          timeoutSec: apiCallTimeoutSec,
        });
        return;
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 408 && Date.now() < coldStartDeadline) {
          continue;
        }
        throw err;
      }
    }
  };

  // 412 "machine still active, refusing to start" can be returned by
  // Fly when `startMachine` is called immediately after the API
  // flipped `state` to `stopped` but before flyd finished reaping the
  // runtime. Bounded retry only on 412; all other errors propagate
  // on the first attempt.
  const startMachineWithRetry = async (machineId: string): Promise<void> => {
    const deadline =
      Date.now() + (opts.startMachineRetryTimeoutSec ?? 10) * 1000;
    while (true) {
      try {
        await opts.machines.startMachine(machineId);
        return;
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 412 && Date.now() < deadline) {
          await sleep(250);
          continue;
        }
        throw err;
      }
    }
  };

  const driveToStarted = async (
    machineId: string,
    machine: Machine,
  ): Promise<Machine> => {
    const timeoutSec = opts.waitTimeoutSec ?? 60;
    if (machine.state === "started") return machine;
    if (machine.state === "stopping" || machine.state === "suspending") {
      await opts.machines.waitForState(machineId, "stopped", { timeoutSec });
      await startMachineWithRetry(machineId);
      await waitForStartedWithRetry(machineId);
      return await opts.machines.getMachine(machineId);
    }
    if (machine.state === "stopped" || machine.state === "suspended") {
      await startMachineWithRetry(machineId);
      await waitForStartedWithRetry(machineId);
      return await opts.machines.getMachine(machineId);
    }
    if (machine.state === "created" || machine.state === "starting") {
      await waitForStartedWithRetry(machineId);
      return await opts.machines.getMachine(machineId);
    }
    throw new Error(
      `upstreamResolver: unexpected machine state ${JSON.stringify(machine.state)}`,
    );
  };

  return (projectId: string) => {
    const existing = inFlight.get(projectId);
    if (existing !== undefined) return existing;
    const p = resolveOnce(projectId).finally(() => {
      if (inFlight.get(projectId) === p) inFlight.delete(projectId);
    });
    inFlight.set(projectId, p);
    return p;
  };
}

// Adapter from the Drizzle storage primitives in `@tex-center/db`
// to the narrow `MachineAssignmentStore` interface above. Kept
// here (not in the db package) so tests can stub the store with
// plain in-memory objects without an indirect mock.
export function dbMachineAssignmentStore(
  db: DrizzleDb,
): MachineAssignmentStore {
  return {
    async get(projectId) {
      const row = await getMachineAssignmentByProjectId(db, projectId);
      if (row === null) return null;
      return {
        machineId: row.machineId,
        region: row.region,
        state: row.state,
      };
    },
    async upsert(input) {
      await upsertMachineAssignment(db, input);
    },
    async updateState(projectId, state) {
      await updateMachineAssignmentState(db, projectId, state);
    },
    async delete(projectId) {
      await deleteMachineAssignment(db, projectId);
    },
  };
}
