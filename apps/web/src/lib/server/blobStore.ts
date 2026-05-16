// Web-tier cold-storage primitive (M20.2(a), dark code).
//
// Surfaces the same `BlobStore` capability the sidecar consumes,
// driven by the same `BLOB_STORE` / `BLOB_STORE_LOCAL_DIR` env
// protocol. The web tier today has no production wiring that
// consults this: the M15 `seedDocFor` chain (db `projects.seed_doc`
// → Machine env at create time) remains the only seed source. This
// module exists so the M20.2(c) cutover — composing `coldSourceFor`
// into `seedDocFor` so a persisted `main.tex` blob wins over the db
// seed and the canonical hello-world fallback — is a one-line wiring
// change rather than a fresh dependency + key-shape decision.
//
// Key-shape note: the canonical per-project source file lives at
// `projects/<id>/files/<MAIN_DOC_NAME>` (`main.tex`). The shape is
// the same one `apps/sidecar/src/persistence.ts::mainTexKey` uses;
// the web tier composes it from the protocol-frozen
// `MAIN_DOC_NAME` and an inline `projects/<id>/files/` prefix
// rather than importing a sidecar-internal helper.

import { MAIN_DOC_NAME } from "@tex-center/protocol";
import {
  defaultBlobStoreFromEnv,
  type BlobStore,
} from "@tex-center/blobs";

export { defaultBlobStoreFromEnv };
export type { BlobStore };

/**
 * Construct a `BlobStore` from environment, or `undefined` if the
 * deploy has opted out (`BLOB_STORE` unset/`none`). The env protocol
 * is shared with the sidecar; see `@tex-center/blobs/envSelect.ts`.
 * `env` defaults to `process.env` for production callers; tests pass
 * an explicit env map.
 */
export function webBlobStoreFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BlobStore | undefined {
  return defaultBlobStoreFromEnv(env);
}

/**
 * Read the persisted `main.tex` source for a project from the blob
 * store, or `null` if no blob exists yet. Returns `null` rather than
 * throwing on a missing blob, but propagates transport errors so the
 * caller can decide whether to log + fall back or fail closed.
 *
 * Today this is dark code: no production caller invokes it. The
 * M20.2(c) cutover composes it into `seedDocFor` in
 * `apps/web/src/server.ts` as the first lookup in a chain
 * (blob → db `seed_doc` → no seed ⇒ `MAIN_DOC_HELLO_WORLD`).
 */
export async function coldSourceFor(
  blobStore: BlobStore,
  projectId: string,
): Promise<string | null> {
  const key = `projects/${projectId}/files/${MAIN_DOC_NAME}`;
  const bytes = await blobStore.get(key);
  if (!bytes || bytes.length === 0) return null;
  return new TextDecoder().decode(bytes);
}
