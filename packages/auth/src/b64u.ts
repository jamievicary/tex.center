// base64url (RFC 4648 §5), no padding. Shared by session-token
// signing and PKCE challenge derivation.

export function b64uEncode(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

export function b64uDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) {
    throw new Error("invalid base64url");
  }
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/gu, "+").replace(/_/gu, "/") + pad, "base64");
}
