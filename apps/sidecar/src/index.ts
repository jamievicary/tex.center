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

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = resolveBindHost(process.env);
  // Idle-stop: 0 disables, anything >0 arms the timer. Default
  // 10 min matches the architecture note in GOAL.md. The Fly
  // Machine `restart: on-failure` policy turns a clean exit
  // into a `stopped` Machine the resolver can later wake.
  const idleRaw = process.env.SIDECAR_IDLE_TIMEOUT_MS;
  const idleTimeoutMs = idleRaw === undefined ? 600_000 : Number(idleRaw);
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  const onIdle = (): void => {
    void (async (): Promise<void> => {
      try {
        if (app) await app.close();
      } finally {
        process.exit(0);
      }
    })();
  };
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
