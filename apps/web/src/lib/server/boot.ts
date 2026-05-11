// Boot a Node http.Server with adapter-node's request handler on
// the HTTP side and the WS proxy from `wsProxy.ts` on the Upgrade
// side. Extracted so the bootstrap can be unit-tested without
// running the production entry's `process.on(SIGTERM, …)` wiring.

import http from "node:http";
import type { RequestListener, Server as HttpServer } from "node:http";

import { attachWsProxy, resolveSidecarUpstream } from "./wsProxy.js";

export interface BootOptions {
  readonly handler: RequestListener;
  readonly host: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BootResult {
  readonly server: HttpServer;
  readonly detachProxy: () => void;
}

export function boot(opts: BootOptions): BootResult {
  const upstream = resolveSidecarUpstream(opts.env);
  const server = http.createServer(opts.handler);
  const detachProxy = attachWsProxy(server, { upstream });
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
