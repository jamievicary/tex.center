// Key validation shared by every BlobStore adapter.
//
// Keys are forward-slash-separated and must not allow path
// traversal in filesystem-backed adapters. We reject empty
// segments, `.` / `..`, leading/trailing slashes, NULs, and
// backslashes (which Windows would interpret as separators).

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("blob key must be a non-empty string");
  }
  if (key.includes("\0") || key.includes("\\")) {
    throw new Error(`invalid blob key: ${key}`);
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw new Error(`invalid blob key (leading/trailing slash): ${key}`);
  }
  for (const seg of key.split("/")) {
    if (seg === "." || seg === "..") {
      throw new Error(`invalid blob key segment '${seg}': ${key}`);
    }
    if (!SEGMENT.test(seg)) {
      throw new Error(`invalid blob key segment '${seg}': ${key}`);
    }
  }
}
