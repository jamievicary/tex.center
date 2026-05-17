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
  createFlyCurrentSidecarImage,
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
  /**
   * M15 Step D: per-project `main.tex` seed lookup. Production
   * wiring goes through `getProjectSeedDoc(db, ...)`. Resolver
   * uses the returned bytes to populate the new Machine's env
   * (`SEED_MAIN_DOC_B64`) at creation time. When omitted, no seed
   * is plumbed and the sidecar defaults to `MAIN_DOC_HELLO_WORLD`.
   */
  readonly seedDocFor?: (projectId: string) => Promise<string | null>;
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
    // pulling the ~5 GB image again. The sidecar's suspend stage
    // calls the Machines API `/suspend` endpoint itself (see
    // `apps/sidecar/src/index.ts::createSuspendHandler`); the
    // longer stop stage exits cleanly (M20.1). Leak
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
    // Native Fly health check on the sidecar's listen port.
    // Complements the resolver's own `waitForUpstreamReady` TCP
    // probe (which the web tier uses to gate WS upgrades): with
    // this declared, Fly's edge proxy ALSO refuses to route to a
    // Machine whose check is failing, closing the small race
    // window between Fly flipping `state` to `started` and the
    // sidecar Node process actually binding to 3001. The check
    // name is exposed in `GET /machines/<id>` under `checks`, so
    // operators (and the resolver, if it ever wants to short-
    // circuit `waitForUpstreamReady`) can observe pass/fail
    // without dialling the port themselves.
    checks: {
      "sidecar-tcp": {
        type: "tcp",
        port: sidecarPort,
        interval: "2s",
        timeout: "1s",
        grace_period: "2s",
      },
    },
  };

  const machines = deps.makeMachinesClient({ token, appName });
  // Iter 378: stale-sidecar-image eviction. Caches the deployment-pool
  // digest for 60 s so a burst of editor opens shares one Fly API
  // round-trip while still converging within a minute of any deploy.
  const currentImage = createFlyCurrentSidecarImage({ machines });
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
    ...(deps.seedDocFor !== undefined ? { seedDocFor: deps.seedDocFor } : {}),
    currentImage,
    onStaleImageEviction: (detail) => {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          kind: "stale-image-eviction",
          projectId: detail.projectId,
          machineId: detail.machineId,
          expectedDigest: detail.expectedDigest,
          actualDigest: detail.actualDigest,
        }),
      );
    },
    onCurrentImageError: (detail) => {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          kind: "current-image-lookup-failed",
          message: detail.message,
        }),
      );
    },
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
