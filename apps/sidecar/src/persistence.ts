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

import { MAIN_DOC_NAME, validateProjectFileName } from "@tex-center/protocol";

export { validateProjectFileName };

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
  /**
   * Sorted list of files this persistence layer is operating on:
   * `MAIN_DOC_NAME` plus every blob discovered during hydration.
   * Always includes `MAIN_DOC_NAME` so callers degrade cleanly when
   * hydration failed or no blob store is configured. Must be called
   * after `awaitHydrated()` for a complete view.
   */
  files(): string[];
  /**
   * Add a new project file. Validates `name` as a single blob-key
   * segment, rejects duplicates (any name already in `files()`),
   * and — when the blob store is wired and hydration succeeded —
   * PUTs an empty blob so the file survives a session restart even
   * if the user never edits it.
   *
   * Returns `{ added: true }` on success, otherwise
   * `{ added: false, reason }` with a short human-readable reason.
   * The in-memory `knownFiles` set is only mutated on success.
   */
  addFile(name: string): Promise<{ added: true } | { added: false; reason: string }>;
  /**
   * Delete a project file. Rejects `MAIN_DOC_NAME` (never removable;
   * the project always has a main entry) and any name not currently
   * in `files()`. Clears the file's `Y.Text` contents in-place
   * (Y.Doc has no remove-type primitive), removes it from
   * `knownFiles` so `maybePersist` no longer touches the key, and —
   * when the blob store is wired and hydration succeeded — deletes
   * the blob.
   *
   * Returns `{ deleted: true }` on success, otherwise
   * `{ deleted: false, reason }`. The in-memory state is only
   * mutated on success.
   */
  deleteFile(name: string): Promise<{ deleted: true } | { deleted: false; reason: string }>;
  /**
   * Rename a project file. Rejects renaming `MAIN_DOC_NAME` (out)
   * and renaming any file to `MAIN_DOC_NAME` (in), any `oldName`
   * not in `files()`, any `newName` already in `files()`, and any
   * `newName` failing `validateProjectFileName`. On accept,
   * inside a single `doc.transact`: copies `oldText` contents into
   * `newText` and clears `oldText`; updates `knownFiles` /
   * `persistedByName`; and — when the blob store is wired and
   * hydration succeeded — PUTs the new key and DELETEs the old.
   * A PUT failure aborts with the old state intact; a DELETE
   * failure after a successful PUT leaves the old blob orphaned
   * (logged, but the rename still succeeds — the in-memory truth
   * has moved on).
   */
  renameFile(
    oldName: string,
    newName: string,
  ): Promise<{ renamed: true } | { renamed: false; reason: string }>;
}

export function createProjectPersistence(args: {
  blobStore: BlobStore | undefined;
  projectId: string;
  doc: Y.Doc;
  log: PersistenceLogger;
}): ProjectPersistence {
  const { blobStore, projectId, doc, log } = args;

  if (!blobStore) {
    // In-memory only: still track created files so `files()` and
    // the broadcast file-list reflect them within this session.
    const memFiles = new Set<string>([MAIN_DOC_NAME]);
    return {
      awaitHydrated: () => Promise.resolve(),
      maybePersist: () => Promise.resolve(),
      files: () => Array.from(memFiles).sort(),
      async addFile(name) {
        const reason = validateProjectFileName(name);
        if (reason) return { added: false, reason };
        if (memFiles.has(name)) return { added: false, reason: "already exists" };
        memFiles.add(name);
        return { added: true };
      },
      async deleteFile(name) {
        if (name === MAIN_DOC_NAME) return { deleted: false, reason: "cannot delete main" };
        if (!memFiles.has(name)) return { deleted: false, reason: "no such file" };
        const t = doc.getText(name);
        if (t.length > 0) t.delete(0, t.length);
        memFiles.delete(name);
        return { deleted: true };
      },
      async renameFile(oldName, newName) {
        if (oldName === MAIN_DOC_NAME) return { renamed: false, reason: "cannot rename main" };
        if (newName === MAIN_DOC_NAME) return { renamed: false, reason: "cannot overwrite main" };
        if (!memFiles.has(oldName)) return { renamed: false, reason: "no such file" };
        const reason = validateProjectFileName(newName);
        if (reason) return { renamed: false, reason };
        if (memFiles.has(newName)) return { renamed: false, reason: "already exists" };
        const oldText = doc.getText(oldName);
        const contents = oldText.toString();
        doc.transact(() => {
          const newText = doc.getText(newName);
          if (newText.length === 0 && contents.length > 0) newText.insert(0, contents);
          if (oldText.length > 0) oldText.delete(0, oldText.length);
        });
        memFiles.delete(oldName);
        memFiles.add(newName);
        return { renamed: true };
      },
    };
  }

  // Files we are willing to persist. Pre-seeded with `MAIN_DOC_NAME`
  // so `files()` exposes a sensible list even if hydration fails;
  // hydration adds every listed blob key. Not extended at runtime
  // since today there's no protocol path to create a new file.
  const knownFiles = new Set<string>([MAIN_DOC_NAME]);
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
    files: () => Array.from(knownFiles).sort(),
    async addFile(name): Promise<{ added: true } | { added: false; reason: string }> {
      const reason = validateProjectFileName(name);
      if (reason) return { added: false, reason };
      if (knownFiles.has(name)) return { added: false, reason: "already exists" };
      if (canPersist) {
        try {
          await blobStore.put(`${projectFilesDir(projectId)}/${name}`, new Uint8Array(0));
          persistedByName.set(name, "");
        } catch (e) {
          log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId },
            `blob create failed for ${name}`,
          );
          return { added: false, reason: "blob create failed" };
        }
      }
      knownFiles.add(name);
      return { added: true };
    },
    async deleteFile(name): Promise<{ deleted: true } | { deleted: false; reason: string }> {
      if (name === MAIN_DOC_NAME) return { deleted: false, reason: "cannot delete main" };
      if (!knownFiles.has(name)) return { deleted: false, reason: "no such file" };
      if (canPersist) {
        try {
          await blobStore.delete(`${projectFilesDir(projectId)}/${name}`);
        } catch (e) {
          log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId },
            `blob delete failed for ${name}`,
          );
          return { deleted: false, reason: "blob delete failed" };
        }
      }
      const t = doc.getText(name);
      if (t.length > 0) t.delete(0, t.length);
      knownFiles.delete(name);
      persistedByName.delete(name);
      return { deleted: true };
    },
    async renameFile(oldName, newName): Promise<{ renamed: true } | { renamed: false; reason: string }> {
      if (oldName === MAIN_DOC_NAME) return { renamed: false, reason: "cannot rename main" };
      if (newName === MAIN_DOC_NAME) return { renamed: false, reason: "cannot overwrite main" };
      if (!knownFiles.has(oldName)) return { renamed: false, reason: "no such file" };
      const reason = validateProjectFileName(newName);
      if (reason) return { renamed: false, reason };
      if (knownFiles.has(newName)) return { renamed: false, reason: "already exists" };
      const oldText = doc.getText(oldName);
      const contents = oldText.toString();
      const dir = projectFilesDir(projectId);
      if (canPersist) {
        try {
          await blobStore.put(`${dir}/${newName}`, new TextEncoder().encode(contents));
        } catch (e) {
          log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId },
            `blob rename PUT failed for ${newName}`,
          );
          return { renamed: false, reason: "blob create failed" };
        }
        try {
          await blobStore.delete(`${dir}/${oldName}`);
        } catch (e) {
          // New key is already written and in-memory truth will
          // move to it; orphan the old blob rather than rolling
          // back (a rollback could fail too and leave both keys
          // populated, which is worse).
          log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId },
            `blob rename DELETE failed for ${oldName} (orphaned)`,
          );
        }
        persistedByName.set(newName, contents);
        persistedByName.delete(oldName);
      }
      doc.transact(() => {
        const newText = doc.getText(newName);
        if (newText.length === 0 && contents.length > 0) newText.insert(0, contents);
        if (oldText.length > 0) oldText.delete(0, oldText.length);
      });
      knownFiles.delete(oldName);
      knownFiles.add(newName);
      return { renamed: true };
    },
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
