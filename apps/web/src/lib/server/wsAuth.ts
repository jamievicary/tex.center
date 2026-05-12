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
  projectId: string,
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

export type LookupProjectOwnerFn = (
  projectId: string,
) => Promise<string | null>;

export interface ProjectAccessAuthoriserOptions
  extends SessionAuthoriserOptions {
  // Returns the project's owner-id, or null if the project does
  // not exist. Throws are caught and treated as "deny" — the proxy
  // must never admit an upgrade because the DB momentarily failed.
  readonly lookupProjectOwner: LookupProjectOwnerFn;
}

// Like `makeSessionAuthoriser`, but additionally asserts that the
// authenticated user owns the project the upgrade is targeted at.
// Required wherever `/ws/project/<id>` lands traffic, since the
// resolver would otherwise create a Fly Machine for any string the
// caller cares to send.
export function makeProjectAccessAuthoriser(
  opts: ProjectAccessAuthoriserOptions,
): UpgradeAuthoriser {
  const now = opts.now ?? (() => Date.now());
  return async (req, projectId) => {
    const cookieHeader = req.headers.cookie ?? null;
    let session;
    try {
      session = await resolveSessionHook({
        cookieHeader,
        sessionCookieName: opts.sessionCookieName,
        signingKey: opts.signingKey,
        nowSeconds: Math.floor(now() / 1000),
        secureCookie: true,
        lookupSession: opts.lookupSession,
      });
    } catch {
      return false;
    }
    if (session.session === null) return false;
    const userId = session.session.user.id;
    let ownerId: string | null;
    try {
      ownerId = await opts.lookupProjectOwner(projectId);
    } catch {
      return false;
    }
    if (ownerId === null) return false;
    return ownerId === userId;
  };
}
