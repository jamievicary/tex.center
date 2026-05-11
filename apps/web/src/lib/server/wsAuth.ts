// WebSocket upgrade authoriser. Wraps `resolveSessionHook` so the
// control-plane WS proxy can reject upgrades from unauthenticated
// callers before the upstream sidecar is dialled. Symmetric with
// `hooks.server.ts`: same cookie name, signing key, and DB lookup,
// so a request that would be redirected to `/` on the HTTP side
// returns 401 on the Upgrade side.

import type { IncomingMessage } from "node:http";

import {
  resolveSessionHook,
  type LookupSessionFn,
} from "./sessionHook.js";

export interface SessionAuthoriserOptions {
  readonly signingKey: Uint8Array;
  readonly sessionCookieName: string;
  readonly lookupSession: LookupSessionFn;
  /** Override for tests. */
  readonly now?: () => number;
}

export type UpgradeAuthoriser = (
  req: IncomingMessage,
) => Promise<boolean>;

export function makeSessionAuthoriser(
  opts: SessionAuthoriserOptions,
): UpgradeAuthoriser {
  const now = opts.now ?? (() => Date.now());
  return async (req) => {
    const cookieHeader = req.headers.cookie ?? null;
    const result = await resolveSessionHook({
      cookieHeader,
      sessionCookieName: opts.sessionCookieName,
      signingKey: opts.signingKey,
      nowSeconds: Math.floor(now() / 1000),
      // Upgrades carry no Set-Cookie back; the value is irrelevant
      // here, but pass true so any future logging path treats it
      // as a TLS context (the real edge is fronted by Fly TLS).
      secureCookie: true,
      lookupSession: opts.lookupSession,
    });
    return result.session !== null;
  };
}
