// Build a per-project upstream resolver from environment
// variables. Used by the production entry to construct the resolver
// without hard-coding the Fly Machines API client or the db
// adapter, so unit tests can supply stubs.
//
// Returns `null` (i.e. "use the static envvar fallback") when any
// required variable is missing. The fallback is the M7.0 shared
// sidecar path that boot() wires up from `SIDECAR_HOST` /
// `SIDECAR_PORT`; per-project Machines only kick in once Fly +
// sidecar config are all present.

import type { MachineConfig, MachinesClient } from "./flyMachines.js";
import {
  createUpstreamResolver,
  defaultTcpProbe,
  type MachineAssignmentStore,
  type UpstreamResolver,
} from "./upstreamResolver.js";
import { DEFAULT_SIDECAR_PORT } from "./wsProxy.js";

export interface UpstreamFromEnvDeps {
  readonly makeMachinesClient: (opts: {
    readonly token: string;
    readonly appName: string;
  }) => MachinesClient;
  readonly makeStore: () => MachineAssignmentStore;
  /**
   * TCP-readiness probe injection point for tests. Defaults to a
   * `net.connect` against the upstream host:port. Tests that want
   * to exercise the resolver against fake hostnames pass a no-op.
   */
  readonly tcpProbe?: (host: string, port: number) => Promise<void>;
}

const DEFAULT_SIDECAR_REGION = "fra";

export function buildUpstreamFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  deps: UpstreamFromEnvDeps,
): UpstreamResolver | null {
  const token = env.FLY_API_TOKEN;
  const appName = env.SIDECAR_APP_NAME;
  const image = env.SIDECAR_IMAGE;
  if (!token || !appName || !image) return null;

  const sidecarPort = parsePort(env.SIDECAR_PORT) ?? DEFAULT_SIDECAR_PORT;
  const sidecarRegion = env.SIDECAR_REGION ?? DEFAULT_SIDECAR_REGION;

  const machineConfig: MachineConfig = {
    image,
    // M13.2(b) iter 249: `auto_destroy` is **off**. Per-project
    // Machines suspend on idle (kernel snapshot, ~300 ms resume)
    // and remain in the Fly app as `suspended`/`stopped`; the
    // next viewer connect resumes the existing VM rather than
    // pulling the ~5 GB image again. The sidecar's idle handler
    // calls the Machines API `/suspend` endpoint itself (see
    // `apps/sidecar/src/index.ts::createIdleHandler`). Leak
    // accumulation is bounded by the orphan-sweep (filters by
    // known project IDs, not by state).
    auto_destroy: false,
    restart: { policy: "on-failure" },
    // Per-project Machines need ≥1GB to survive the runtime
    // total-vm footprint of the sidecar (Node + lualatex-incremental
    // ELF + fmt dump). The Fly Machines API default (~256MB) OOM-
    // killed Machines on first WS request — see iter 153 log + iter
    // 154 PLAN entry. cgroup memory accounting tracks total VM, not
    // RSS, so even a small-RSS process is killed if its mappings
    // exceed the limit.
    guest: { memory_mb: 1024, cpu_kind: "shared", cpus: 1 },
  };

  const machines = deps.makeMachinesClient({ token, appName });
  return createUpstreamResolver({
    machines,
    store: deps.makeStore(),
    sidecarPort,
    sidecarRegion,
    machineConfig,
    // 5-minute cold-start budget. Live iter-164 trace observed
    // fresh Machines taking 1m12s + 1m38s to reach `started`
    // (image pull). Fly's `/wait` API caps a single call at 60s
    // and returns 408 on miss; the resolver retries under this
    // overall deadline.
    coldStartTimeoutSec: 300,
    tcpProbe: deps.tcpProbe ?? defaultTcpProbe,
    // Iter 168: after `started`, give the sidecar 60s to actually
    // bind the listen port. In practice this is sub-second on a
    // warm image and a few seconds on a cold pull.
    tcpProbeTimeoutSec: 60,
  });
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `SIDECAR_PORT must be a positive integer ≤ 65535 (got ${JSON.stringify(raw)})`,
    );
  }
  return parsed;
}
