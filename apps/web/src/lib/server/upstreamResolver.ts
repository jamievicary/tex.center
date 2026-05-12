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

    return {
      host: opts.machines.internalAddress(machineId),
      port: opts.sidecarPort,
    };
  };

  const ensureMachineId = async (projectId: string): Promise<string> => {
    const cached = await opts.store.get(projectId);
    if (cached !== null) return cached.machineId;
    const created = await opts.machines.createMachine({
      region: opts.sidecarRegion,
      config: opts.machineConfig,
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

  const driveToStarted = async (
    machineId: string,
    machine: Machine,
  ): Promise<Machine> => {
    const timeoutSec = opts.waitTimeoutSec ?? 60;
    if (machine.state === "started") return machine;
    if (machine.state === "stopping" || machine.state === "suspending") {
      await opts.machines.waitForState(machineId, "stopped", { timeoutSec });
      await opts.machines.startMachine(machineId);
      await waitForStartedWithRetry(machineId);
      return await opts.machines.getMachine(machineId);
    }
    if (machine.state === "stopped" || machine.state === "suspended") {
      await opts.machines.startMachine(machineId);
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
