// Email allowlist for tex.center MVP.
//
// GOAL.md is explicit: only jamievicary@gmail.com is admitted.
// Any other Google account that completes OAuth is signed out
// immediately and returned to the white page. The check is a
// case-insensitive exact match — Google normalises the
// `email` claim to lower-case in practice, but we don't want a
// stray uppercase header to lock the owner out either.

export const ALLOWED_EMAILS: readonly string[] = ["jamievicary@gmail.com"];

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0) return false;
  return ALLOWED_EMAILS.includes(normalised);
}
