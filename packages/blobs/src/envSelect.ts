// Env-driven `BlobStore` selector shared by sidecar and web tier.
//
// Protocol (single source of truth so a single deploy config wires
// both sides identically):
//
//   - `BLOB_STORE` unset / "none" → undefined (no persistence; the
//     caller decides whether that is acceptable).
//   - `BLOB_STORE=local` → `LocalFsBlobStore` rooted at
//     `BLOB_STORE_LOCAL_DIR` (required). Used by tests, local dev,
//     and any single-host setup that doesn't need cross-machine
//     sharing.
//   - `BLOB_STORE=s3` → reserved for the upcoming Tigris/S3 adapter
//     (M20.2 cold-storage cutover); rejected for now with a clear
//     error so a misconfigured deploy fails fast at boot rather
//     than degrading silently to a per-Machine local dir.

import type { BlobStore } from "./index.js";
import { LocalFsBlobStore } from "./localFs.js";

export function defaultBlobStoreFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BlobStore | undefined {
  const which = env.BLOB_STORE;
  if (!which || which === "none") return undefined;
  if (which === "local") {
    const dir = env.BLOB_STORE_LOCAL_DIR;
    if (!dir) {
      throw new Error("BLOB_STORE=local requires BLOB_STORE_LOCAL_DIR");
    }
    return new LocalFsBlobStore({ rootDir: dir });
  }
  if (which === "s3") {
    throw new Error("BLOB_STORE=s3 not implemented yet (M20.2 cutover)");
  }
  throw new Error(`unknown BLOB_STORE: ${which}`);
}
