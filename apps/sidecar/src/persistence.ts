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
// Hydration loads every persisted file under `projects/<id>/files/`
// into its own `Y.Text` on the project's single `Y.Doc`, keyed by
// the relative path (so `main.tex`, `refs.bib`, etc. each live on
// `doc.getText(<name>)`). The Y.Doc-level update wire format
// already carries every type, so no protocol change is needed for
// the read side.
//
// Persistence is per-file. `maybePersist()` walks every file in
// `knownFiles` (the set seeded at hydration time: `MAIN_DOC_NAME`
// plus every listed key) and PUTs each whose current `Y.Text`
// contents differ from the last-persisted snapshot. A per-file PUT
// failure is logged and does not abort the rest — one transient
// outage on `refs.bib` must not lose a `main.tex` edit.

import * as Y from "yjs";

import type { BlobStore } from "@tex-center/blobs";
import { LocalFsBlobStore } from "@tex-center/blobs";

import { MAIN_DOC_NAME } from "@tex-center/protocol";

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
   * Persist every known file whose current `Y.Text` contents differ
   * from the last persisted value. No-op when `blobStore` was not
   * provided or hydration failed.
   */
  maybePersist(): Promise<void>;
}

export function createProjectPersistence(args: {
  blobStore: BlobStore | undefined;
  projectId: string;
  doc: Y.Doc;
  log: PersistenceLogger;
}): ProjectPersistence {
  const { blobStore, projectId, doc, log } = args;

  if (!blobStore) {
    return {
      awaitHydrated: () => Promise.resolve(),
      maybePersist: () => Promise.resolve(),
    };
  }

  // Files we are willing to persist. Seeded at hydration time with
  // `MAIN_DOC_NAME` plus every listed blob key; not extended at
  // runtime since today there's no protocol path to create a new
  // file.
  const knownFiles = new Set<string>();
  // Last-persisted source per file. Absence means "no blob known
  // yet" — the next `maybePersist` will create one even if the
  // current `Y.Text` is empty, preserving the historical
  // "first-compile establishes main.tex" semantics.
  const persistedByName = new Map<string, string>();
  let canPersist = false;

  const hydrated: Promise<void> = (async () => {
    try {
      const files = await listProjectFiles(blobStore, projectId);
      // Bulk-load every file into its own Y.Text inside a single
      // transaction so observers see one coherent update rather
      // than one per file.
      const dec = new TextDecoder();
      const loaded = await Promise.all(
        files.map(async (name) => ({
          name,
          bytes: await blobStore.get(`${projectFilesDir(projectId)}/${name}`),
        })),
      );
      doc.transact(() => {
        for (const { name, bytes } of loaded) {
          if (!bytes || bytes.length === 0) continue;
          const t = doc.getText(name);
          if (t.length === 0) t.insert(0, dec.decode(bytes));
        }
      });
      knownFiles.add(MAIN_DOC_NAME);
      for (const { name, bytes } of loaded) {
        knownFiles.add(name);
        // An existing-but-empty blob counts as persisted-as-"".
        // A `get` returning `null` (unlikely from `list` output, but
        // tolerated) leaves the entry unset so the next compile
        // re-establishes it.
        if (bytes) persistedByName.set(name, dec.decode(bytes));
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
    async maybePersist(): Promise<void> {
      if (!canPersist) return;
      const enc = new TextEncoder();
      const dir = projectFilesDir(projectId);
      for (const name of knownFiles) {
        const source = doc.getText(name).toString();
        if (persistedByName.get(name) === source) continue;
        try {
          await blobStore.put(`${dir}/${name}`, enc.encode(source));
          persistedByName.set(name, source);
        } catch (e) {
          log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId },
            `blob persist failed for ${name}`,
          );
        }
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
