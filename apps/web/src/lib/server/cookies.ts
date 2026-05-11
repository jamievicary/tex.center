// Shared cookie helpers for `apps/web` server-side code.
//
// Every cookie this app sets (`tc_oauth_state`, `tc_session`) and
// every clear-cookie directive emitted by the auth flow share the
// same attribute shape: `Path; HttpOnly; SameSite=Lax; Max-Age;
// [Secure]`. Until iter 50 each module hand-rolled its own
// builder; drift between them (a missing attribute, a different
// order) would be a real security bug. One builder + one reader,
// used everywhere.

export interface SetCookieOptions {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}

export function formatSetCookie(opts: SetCookieOptions): string {
  const attrs = [
    `${opts.name}=${opts.value}`,
    `Path=${opts.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export interface ClearCookieOptions {
  readonly name: string;
  readonly path: string;
  readonly secure: boolean;
}

export function formatClearCookie(opts: ClearCookieOptions): string {
  return formatSetCookie({
    name: opts.name,
    value: "",
    path: opts.path,
    maxAgeSeconds: 0,
    secure: opts.secure,
  });
}

/** Parse a single cookie by name from a `Cookie` header value. */
export function readCookie(
  header: string | null,
  name: string,
): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}
