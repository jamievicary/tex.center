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

/**
 * Resolves the image digest new sidecar Machines should be running.
 * Implementations may cache; the resolver calls `getCurrent()` once
 * per resolution and tolerates a thrown rejection by skipping the
 * eviction check (fail-open).
 */
export interface CurrentSidecarImage {
  getCurrent(): Promise<string>;
}
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
  /**
   * Iter 378 — stale-sidecar-image eviction. When provided, the
   * resolver compares the assigned Machine's `image_ref.digest`
   * against `currentImage.getCurrent()`; on mismatch it force-
   * destroys the Machine, drops the assignment row, and falls into
   * the existing "no cached row → create fresh" path. This spreads
   * post-deploy cold-starts across "next user open" rather than
   * concentrating them at deploy time. Omit (or pass an
   * implementation that always throws) to disable.
   */
  readonly currentImage?: CurrentSidecarImage;
  /**
   * Observability hook for stale-image evictions. Fires after the
   * destroy + delete succeeds, before the recreate. Both digests
   * are the canonical `sha256:…` form; `expected` is the value
   * returned by `currentImage.getCurrent()`.
   */
  readonly onStaleImageEviction?: (detail: {
    projectId: string;
    machineId: string;
    expectedDigest: string;
    actualDigest: string;
  }) => void;
  /**
   * Reporter for `currentImage.getCurrent()` failures. The resolver
   * always proceeds (fail-open) when the lookup throws — a single
   * protocol-drift session is better than wedging every editor open
   * behind a flaky Fly API call — but the failure is worth
   * surfacing.
   */
  readonly onCurrentImageError?: (detail: { message: string }) => void;
}

/**
 * Pure helper: extract the canonical `sha256:…` digest from a
 * Machine's `image_ref`. Returns null when the field isn't present
 * or isn't a non-empty string. The resolver short-circuits eviction
 * when either side is null (can't compare what we don't have).
 */
export function machineImageDigest(machine: Machine): string | null {
  const digest = machine.image_ref?.digest;
  if (typeof digest !== "string" || digest.length === 0) return null;
  return digest;
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

    // Iter 378 — stale-image eviction. Per-project Machines aren't
    // touched by `flyctl deploy`, so after a sidecar deploy the
    // assigned Machine keeps running the old image — silently breaking
    // any wire-protocol bump (e.g. the iter-370/372 17→18-byte
    // pdf-segment header). Check the assigned Machine's digest against
    // what new sidecars *should* be running; if they differ, evict
    // and fall through to the create path.
    if (opts.currentImage !== undefined) {
      const actualDigest = machineImageDigest(machine);
      let expectedDigest: string | null = null;
      try {
        expectedDigest = await opts.currentImage.getCurrent();
      } catch (err) {
        // Fail open: surface the failure but don't block the session.
        opts.onCurrentImageError?.({ message: errorMessage(err) });
      }
      if (
        actualDigest !== null &&
        expectedDigest !== null &&
        actualDigest !== expectedDigest
      ) {
        await opts.machines.destroyMachine(machineId, { force: true });
        await opts.store.delete(projectId);
        opts.onStaleImageEviction?.({
          projectId,
          machineId,
          expectedDigest,
          actualDigest,
        });
        machineId = await ensureMachineId(projectId);
        machine = await opts.machines.getMachine(machineId);
      }
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

/**
 * Iter 378 — Fly-backed `CurrentSidecarImage`.
 *
 * "Current" = the `image_ref.digest` of the deployment-pool Machine
 * with the highest `fly_release_version`. The deploy-pool Machines
 * are created by `flyctl deploy` and carry
 * `config.metadata.fly_process_group === "app"` plus a numeric
 * `fly_release_version`; per-project Machines (which we manage) have
 * neither, so the filter cleanly excludes them. The highest release
 * version is what new on-demand Machines inherit.
 *
 * Cached in-process; the resolver hits this on every session. Default
 * TTL 60 s — short enough to converge within a minute of a deploy,
 * long enough that a burst of editor opens shares one Fly API round-
 * trip.
 *
 * On API failure the underlying `Promise` rejects; the resolver
 * catches and fail-opens. A successful response refreshes the cache;
 * a thrown lookup leaves the prior cached value in place so transient
 * Fly hiccups don't force every editor open to skip eviction.
 */
export interface CurrentSidecarImageFlyOptions {
  readonly machines: Pick<MachinesClient, "listMachines">;
  /** Cache TTL in ms. Default 60_000 (60 s). */
  readonly ttlMs?: number;
  /** Clock injection for tests. Default `Date.now`. */
  readonly now?: () => number;
}

export function createFlyCurrentSidecarImage(
  opts: CurrentSidecarImageFlyOptions,
): CurrentSidecarImage {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  let cached: { digest: string; expiresAt: number } | null = null;
  return {
    async getCurrent(): Promise<string> {
      if (cached !== null && now() < cached.expiresAt) {
        return cached.digest;
      }
      const all = await opts.machines.listMachines();
      let best: { version: number; digest: string } | null = null;
      for (const m of all) {
        const config = (m as { config?: unknown }).config;
        if (typeof config !== "object" || config === null) continue;
        const metadata = (config as { metadata?: unknown }).metadata;
        if (typeof metadata !== "object" || metadata === null) continue;
        const meta = metadata as Record<string, unknown>;
        if (meta.fly_process_group !== "app") continue;
        const verRaw = meta.fly_release_version;
        if (typeof verRaw !== "string") continue;
        const version = Number.parseInt(verRaw, 10);
        if (!Number.isInteger(version)) continue;
        const digest = m.image_ref?.digest;
        if (typeof digest !== "string" || digest.length === 0) continue;
        if (best === null || version > best.version) best = { version, digest };
      }
      if (best === null) {
        throw new Error(
          "createFlyCurrentSidecarImage: no deployment-pool Machine with " +
            "`fly_process_group=app` + numeric `fly_release_version` + " +
            "`image_ref.digest` found; cannot determine current image",
        );
      }
      cached = { digest: best.digest, expiresAt: now() + ttlMs };
      return best.digest;
    },
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
