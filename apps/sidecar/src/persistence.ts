// Per-project blob-store hydration and persistence policy.
//
// The sidecar holds an in-memory `Y.Doc` per project and treats the
// remote blob store as the source of truth for the project's source
// files. Two operations matter:
//
//   - **Hydrate**: on first open, load the persisted source into the
//     fresh `Y.Text` before the first client sees state, so the
//     initial Yjs frame already reflects what's on disk.
//   - **Persist**: after every successful `writeMain`, push the
//     current source back to the blob store if it differs from what
//     we last persisted.
//
// The `canPersist` invariant (iter 29) is the load-bearing piece:
// persistence is gated on hydration having completed without
// throwing. Without it, a transient `blobStore.get` failure would
// leave `persistedSource` at `null`, and the next compile's diff
// check (`source !== null`) would silently overwrite the legitimate
// remote blob with whatever's in the empty in-memory `Y.Text`.
//
// When `blobStore` is `undefined`, hydration resolves immediately
// and `maybePersist` is a no-op — the sidecar runs purely in-memory.
//
// Today only `main.tex` is persisted; multi-file is post-MVP and
// will turn `persistedSource` into a per-file map keyed by relative
// path.

import * as Y from "yjs";

import type { BlobStore } from "@tex-center/blobs";
import { LocalFsBlobStore } from "@tex-center/blobs";

export interface PersistenceLogger {
  warn(detail: { err: string; projectId?: string }, msg: string): void;
}

/**
 * Blob-store key (no trailing slash) for the directory under which
 * a project's source files live. `validateKey` forbids trailing
 * slashes, so the slash is added by callers that want a strict
 * "this segment, then any descendant" prefix.
 */
export function projectFilesDir(projectId: string): string {
  return `projects/${projectId}/files`;
}

/**
 * Blob-store key for the canonical source of a project's main file.
 */
export function mainTexKey(projectId: string): string {
  return `${projectFilesDir(projectId)}/main.tex`;
}

/**
 * List the relative paths of a project's source files. Returns
 * project-relative paths (the `projects/<id>/files/` prefix is
 * stripped) in lex order. A sibling key whose name merely starts
 * with `files` (e.g. `projects/<id>/files-meta`) is excluded — the
 * filter requires the trailing slash. Hydration of the in-memory
 * Y.Doc still touches `main.tex` only; this primitive exists for
 * the file-tree surface and the eventual multi-file persistence
 * step.
 */
export async function listProjectFiles(
  blobStore: BlobStore,
  projectId: string,
): Promise<string[]> {
  const dirKey = projectFilesDir(projectId);
  const dirSlash = `${dirKey}/`;
  const keys = await blobStore.list(dirKey);
  const out: string[] = [];
  for (const k of keys) {
    if (k.startsWith(dirSlash)) out.push(k.slice(dirSlash.length));
  }
  return out;
}

export interface ProjectPersistence {
  /** Resolves once initial hydration has settled (success or failure). */
  awaitHydrated(): Promise<void>;
  /**
   * Persist `source` if hydration succeeded AND `source` differs from
   * the last persisted value. No-op when `blobStore` was not provided.
   */
  maybePersist(source: string): Promise<void>;
}

export function createProjectPersistence(args: {
  blobStore: BlobStore | undefined;
  projectId: string;
  text: Y.Text;
  log: PersistenceLogger;
}): ProjectPersistence {
  const { blobStore, projectId, text, log } = args;

  if (!blobStore) {
    return {
      awaitHydrated: () => Promise.resolve(),
      maybePersist: () => Promise.resolve(),
    };
  }

  let persistedSource: string | null = null;
  let canPersist = false;

  const hydrated: Promise<void> = (async () => {
    try {
      const bytes = await blobStore.get(mainTexKey(projectId));
      if (bytes && bytes.length > 0) {
        const source = new TextDecoder().decode(bytes);
        text.insert(0, source);
        persistedSource = source;
      } else if (bytes) {
        persistedSource = "";
      }
      canPersist = true;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), projectId },
        "blob hydration failed; persistence disabled this session",
      );
    }
  })();

  return {
    awaitHydrated: () => hydrated,
    async maybePersist(source: string): Promise<void> {
      if (!canPersist) return;
      if (source === persistedSource) return;
      try {
        await blobStore.put(mainTexKey(projectId), new TextEncoder().encode(source));
        persistedSource = source;
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), projectId },
          "blob persist failed",
        );
      }
    },
  };
}

// Selects a default `BlobStore` from environment:
//   - `BLOB_STORE` unset / "none" → undefined (no persistence)
//   - "local" → `LocalFsBlobStore` rooted at `$BLOB_STORE_LOCAL_DIR`
//   - "s3"    → reserved for M4.3.1; rejected for now
export function defaultBlobStoreFromEnv(): BlobStore | undefined {
  const which = process.env.BLOB_STORE;
  if (!which || which === "none") return undefined;
  if (which === "local") {
    const dir = process.env.BLOB_STORE_LOCAL_DIR;
    if (!dir) {
      throw new Error("BLOB_STORE=local requires BLOB_STORE_LOCAL_DIR");
    }
    return new LocalFsBlobStore({ rootDir: dir });
  }
  if (which === "s3") {
    throw new Error("BLOB_STORE=s3 not implemented yet (M4.3.1)");
  }
  throw new Error(`unknown BLOB_STORE: ${which}`);
}
