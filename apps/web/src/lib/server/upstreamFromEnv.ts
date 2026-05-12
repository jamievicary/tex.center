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
    auto_destroy: false,
    restart: { policy: "on-failure" },
  };

  const machines = deps.makeMachinesClient({ token, appName });
  return createUpstreamResolver({
    machines,
    store: deps.makeStore(),
    sidecarPort,
    sidecarRegion,
    machineConfig,
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
