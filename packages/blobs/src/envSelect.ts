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
//   - `BLOB_STORE=s3` → `S3BlobStore` against any S3-compatible
//     endpoint (Tigris in production). Requires `BLOB_STORE_S3_*`
//     fields below; missing fields fail fast at boot rather than
//     degrading silently.

import type { BlobStore } from "./index.js";
import { LocalFsBlobStore } from "./localFs.js";
import { S3BlobStore } from "./s3.js";

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
    const endpoint = required(env, "BLOB_STORE_S3_ENDPOINT");
    const region = required(env, "BLOB_STORE_S3_REGION");
    const bucket = required(env, "BLOB_STORE_S3_BUCKET");
    const accessKeyId = required(env, "BLOB_STORE_S3_ACCESS_KEY_ID");
    const secretAccessKey = required(env, "BLOB_STORE_S3_SECRET_ACCESS_KEY");
    return new S3BlobStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
  }
  throw new Error(`unknown BLOB_STORE: ${which}`);
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const v = env[key];
  if (!v) throw new Error(`BLOB_STORE=s3 requires ${key}`);
  return v;
}
