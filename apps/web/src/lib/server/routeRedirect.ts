// Pure routing-policy helper used by `hooks.server.ts`.
//
// Given the resolved session, request method, and pathname,
// decide whether the hook should short-circuit with a 302 (and
// to where). Returns the Location header value, or `null` to
// continue with normal SvelteKit handling.
//
// Two rules today:
//   - Unauthenticated request to a protected prefix → /
//     (the white sign-in page). Method-agnostic: a stray POST
//     to /editor from a stale form should still bounce.
//   - Authenticated GET to a sign-in page (`/`) → /editor. The
//     GET filter is deliberate: never redirect on POST so a
//     future form posting to `/` isn't silently bounced.
//
// The two rules are mutually exclusive on `session` so order
// doesn't matter, but the protected-prefix case is listed first
// because it is the security-relevant one.

import type { ResolvedSession } from "./sessionHook.js";

export const SIGNED_OUT_PATH = "/";
export const SIGNED_IN_HOME = "/editor";
export const PROTECTED_PREFIXES: readonly string[] = ["/editor"];
export const SIGN_IN_PAGE_PATHS: ReadonlySet<string> = new Set(["/"]);

export interface RouteRedirectInput {
  readonly session: ResolvedSession | null;
  readonly method: string;
  readonly pathname: string;
}

export function routeRedirect(input: RouteRedirectInput): string | null {
  if (
    input.session === null &&
    PROTECTED_PREFIXES.some((p) => input.pathname.startsWith(p))
  ) {
    return SIGNED_OUT_PATH;
  }
  if (
    input.session !== null &&
    input.method === "GET" &&
    SIGN_IN_PAGE_PATHS.has(input.pathname)
  ) {
    return SIGNED_IN_HOME;
  }
  return null;
}
