// Boot a Node http.Server with adapter-node's request handler on
// the HTTP side and the WS proxy from `wsProxy.ts` on the Upgrade
// side. Extracted so the bootstrap can be unit-tested without
// running the production entry's `process.on(SIGTERM, …)` wiring.

import http from "node:http";
import type { RequestListener, Server as HttpServer } from "node:http";

import {
  attachWsProxy,
  resolveSidecarUpstream,
  type UpstreamSource,
} from "./wsProxy.js";
import type { UpgradeAuthoriser } from "./wsAuth.js";

export interface BootOptions {
  readonly handler: RequestListener;
  readonly host: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  // Optional. If absent, the WS proxy accepts all upgrades; the
  // production entry always supplies one (see `server.ts`).
  readonly authoriseUpgrade?: UpgradeAuthoriser;
  // Optional per-project upstream resolver. If absent, all
  // projects route to the static envvar-driven sidecar
  // (`SIDECAR_HOST` / `SIDECAR_PORT`); this is the M7.0 path.
  // M7.1.2 wires a real `createUpstreamResolver(...)` here.
  readonly resolveUpstream?: UpstreamSource;
}

export interface BootResult {
  readonly server: HttpServer;
  readonly detachProxy: () => void;
}

export function boot(opts: BootOptions): BootResult {
  const upstream: UpstreamSource =
    opts.resolveUpstream ?? resolveSidecarUpstream(opts.env);
  const server = http.createServer(opts.handler);
  const detachProxy = attachWsProxy(server, {
    upstream,
    ...(opts.authoriseUpgrade
      ? { authoriseUpgrade: opts.authoriseUpgrade }
      : {}),
  });
  server.listen(opts.port, opts.host);
  return { server, detachProxy };
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `PORT must be an integer in [0, 65535] (got ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}
