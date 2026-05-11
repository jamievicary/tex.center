// Control-plane WebSocket proxy.
//
// In production the SvelteKit app (adapter-node) handles HTTP, and
// the per-project sidecar handles WebSockets. For now there is one
// shared sidecar Fly app reached over 6PN at
// `tex-center-sidecar.internal:3001`; M7.1 swaps that for per-
// project Machines. Either way the browser's WebSocket points at
// the control-plane origin (`wss://tex.center/ws/project/<id>`),
// and this module forwards the upgrade through to the upstream.
//
// Forwarding is byte-level: we accept the HTTP/1.1 Upgrade on the
// client socket, dial the upstream over TCP, write the same request
// line + headers (with `Host:` rewritten to the upstream authority),
// then pipe the two sockets together. No `ws` dep needed — the
// proxy never inspects WebSocket frames.
//
// Auth gating is intentionally NOT in this module — it belongs in
// the hook that attaches the proxy to the http.Server (next slice).
// Keeping the proxy pure lets unit tests boot it standalone against
// a stub upstream.

import net from "node:net";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface SidecarUpstream {
  readonly host: string;
  readonly port: number;
}

export const DEFAULT_SIDECAR_HOST = "tex-center-sidecar.internal";
export const DEFAULT_SIDECAR_PORT = 3001;

// `/ws/project/<id>` → `<id>` (validated). Anything else → null.
// Trailing slashes are rejected: routes must match exactly.
export function matchWsProjectPath(pathname: string): string | null {
  const prefix = "/ws/project/";
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  if (tail.length === 0 || !PROJECT_ID_RE.test(tail)) return null;
  return tail;
}

export function resolveSidecarUpstream(
  env: Readonly<Record<string, string | undefined>>,
): SidecarUpstream {
  const host = env.SIDECAR_HOST ?? DEFAULT_SIDECAR_HOST;
  const portRaw = env.SIDECAR_PORT;
  let port = DEFAULT_SIDECAR_PORT;
  if (portRaw !== undefined) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(
        `SIDECAR_PORT must be a positive integer ≤ 65535 (got ${JSON.stringify(portRaw)})`,
      );
    }
    port = parsed;
  }
  return { host, port };
}

// Render request headers for forwarding. `Host:` is rewritten to
// the upstream authority; everything else is passed through as-is
// (including the WebSocket key, version, and any cookies — the
// upstream sidecar can re-validate at the application layer).
//
// `rawHeaders` is the Node-supplied alternating [name, value, ...]
// array, which preserves duplicates and original casing.
export function renderForwardedHeaders(
  rawHeaders: readonly string[],
  upstream: SidecarUpstream,
): string {
  const upstreamAuthority =
    upstream.port === 80 || upstream.port === 443
      ? upstream.host
      : `${upstream.host}:${upstream.port}`;
  const lines: string[] = [];
  let hostSeen = false;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    if (name.toLowerCase() === "host") {
      if (hostSeen) continue;
      hostSeen = true;
      lines.push(`${name}: ${upstreamAuthority}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!hostSeen) {
    lines.push(`Host: ${upstreamAuthority}`);
  }
  return lines.join("\r\n") + "\r\n";
}

export interface WsProxyOptions {
  readonly upstream: SidecarUpstream;
  // Bounded connect timeout for the upstream dial. If `null`, no
  // timeout (don't use in prod — Fly 6PN should answer fast).
  readonly connectTimeoutMs?: number;
  // Optional pre-flight authorisation. Resolves true to proxy
  // the upgrade, false to reject with HTTP 401. A throw or
  // rejection is treated as 401 — the proxy must never leak the
  // upstream to an unauthenticated caller because the cookie
  // store was momentarily unavailable.
  readonly authoriseUpgrade?: (
    req: IncomingMessage,
  ) => boolean | Promise<boolean>;
  // Hook for tests / logs. Errors here must not throw — they're
  // best-effort observability.
  readonly onEvent?: (event: WsProxyEvent) => void;
}

export type WsProxyEvent =
  | { kind: "no-match"; pathname: string }
  | { kind: "unauthorised"; projectId: string }
  | { kind: "auth-error"; projectId: string; message: string }
  | { kind: "upstream-connect"; projectId: string; upstream: SidecarUpstream }
  | { kind: "upstream-connected"; projectId: string }
  | { kind: "upstream-error"; projectId: string; message: string }
  | { kind: "client-error"; projectId: string; message: string }
  | { kind: "closed"; projectId: string };

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

// Attach an 'upgrade' handler that proxies `/ws/project/<id>` to
// the upstream sidecar. Other paths get the socket destroyed —
// adapter-node's handler does not natively handle Upgrade requests,
// so leaving the socket dangling would hang the client.
//
// Returns a `detach()` that removes the listener; useful for tests.
export function attachWsProxy(
  server: HttpServer,
  options: WsProxyOptions,
): () => void {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const writeStatusAndClose = (
    clientSocket: Duplex,
    status: string,
  ): void => {
    try {
      clientSocket.write(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    } catch {
      // Socket may already be dead.
    }
    clientSocket.destroy();
  };

  const handler = (
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): void => {
    const rawUrl = req.url ?? "";
    const url = new URL(rawUrl, "http://localhost");
    const projectId = matchWsProjectPath(url.pathname);
    if (projectId === null) {
      options.onEvent?.({ kind: "no-match", pathname: url.pathname });
      writeStatusAndClose(clientSocket, "404 Not Found");
      return;
    }

    const proceed = (): void => {
      options.onEvent?.({
        kind: "upstream-connect",
        projectId,
        upstream: options.upstream,
      });
      dialAndPipe(req, clientSocket, head, rawUrl, projectId);
    };

    if (options.authoriseUpgrade === undefined) {
      proceed();
      return;
    }

    let authResult: boolean | Promise<boolean>;
    try {
      authResult = options.authoriseUpgrade(req);
    } catch (err) {
      options.onEvent?.({
        kind: "auth-error",
        projectId,
        message: err instanceof Error ? err.message : String(err),
      });
      writeStatusAndClose(clientSocket, "401 Unauthorized");
      return;
    }
    Promise.resolve(authResult).then(
      (ok) => {
        if (ok) {
          proceed();
        } else {
          options.onEvent?.({ kind: "unauthorised", projectId });
          writeStatusAndClose(clientSocket, "401 Unauthorized");
        }
      },
      (err: unknown) => {
        options.onEvent?.({
          kind: "auth-error",
          projectId,
          message: err instanceof Error ? err.message : String(err),
        });
        writeStatusAndClose(clientSocket, "401 Unauthorized");
      },
    );
  };

  const dialAndPipe = (
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    rawUrl: string,
    projectId: string,
  ): void => {
    const upstream = net.connect(options.upstream.port, options.upstream.host);
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;

    const cleanup = (reason: WsProxyEvent): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      options.onEvent?.(reason);
      try {
        upstream.destroy();
      } catch {}
      try {
        clientSocket.destroy();
      } catch {}
    };

    if (timeoutMs > 0) {
      connectTimer = setTimeout(() => {
        cleanup({
          kind: "upstream-error",
          projectId,
          message: `connect timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }

    upstream.once("connect", () => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      options.onEvent?.({ kind: "upstream-connected", projectId });
      try {
        const requestLine = `${req.method ?? "GET"} ${rawUrl} HTTP/${req.httpVersion ?? "1.1"}\r\n`;
        const headerBlock = renderForwardedHeaders(
          req.rawHeaders,
          options.upstream,
        );
        upstream.write(requestLine + headerBlock + "\r\n");
        if (head.length > 0) upstream.write(head);
      } catch (err) {
        cleanup({
          kind: "upstream-error",
          projectId,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("error", (err) => {
      cleanup({
        kind: "upstream-error",
        projectId,
        message: err.message,
      });
    });
    clientSocket.on("error", (err) => {
      cleanup({
        kind: "client-error",
        projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    upstream.on("close", () => {
      cleanup({ kind: "closed", projectId });
    });
    clientSocket.on("close", () => {
      cleanup({ kind: "closed", projectId });
    });
  };
  server.on("upgrade", handler);
  return () => {
    server.off("upgrade", handler);
  };
}
