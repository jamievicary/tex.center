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
//     endpoint (Tigris in production). Each required field accepts
//     either an explicit `BLOB_STORE_S3_*` name or the standard
//     AWS-SDK env name that `flyctl storage create` auto-injects:
//
//         BLOB_STORE_S3_ENDPOINT           AWS_ENDPOINT_URL_S3
//         BLOB_STORE_S3_REGION             AWS_REGION
//         BLOB_STORE_S3_BUCKET             BUCKET_NAME
//         BLOB_STORE_S3_ACCESS_KEY_ID      AWS_ACCESS_KEY_ID
//         BLOB_STORE_S3_SECRET_ACCESS_KEY  AWS_SECRET_ACCESS_KEY
//
//     The `BLOB_STORE_S3_*` name wins per-field when both are set
//     (explicit override of Fly's auto-injected secrets). A missing
//     field fails fast at boot with both candidate names in the
//     error.

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
    const endpoint = requiredOneOf(
      env,
      "BLOB_STORE_S3_ENDPOINT",
      "AWS_ENDPOINT_URL_S3",
    );
    const region = requiredOneOf(env, "BLOB_STORE_S3_REGION", "AWS_REGION");
    const bucket = requiredOneOf(env, "BLOB_STORE_S3_BUCKET", "BUCKET_NAME");
    const accessKeyId = requiredOneOf(
      env,
      "BLOB_STORE_S3_ACCESS_KEY_ID",
      "AWS_ACCESS_KEY_ID",
    );
    const secretAccessKey = requiredOneOf(
      env,
      "BLOB_STORE_S3_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY",
    );
    return new S3BlobStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
  }
  throw new Error(`unknown BLOB_STORE: ${which}`);
}

function requiredOneOf(
  env: Readonly<Record<string, string | undefined>>,
  primaryKey: string,
  fallbackKey: string,
): string {
  const v = env[primaryKey];
  if (v) return v;
  const fb = env[fallbackKey];
  if (fb) return fb;
  throw new Error(
    `BLOB_STORE=s3 requires ${primaryKey} or ${fallbackKey}`,
  );
}
