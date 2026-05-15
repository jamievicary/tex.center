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
//
// **Workspace mirror (M23.2).** An optional `ProjectWorkspace` is
// kept in sync alongside Yjs: every successful `addFile` /
// `deleteFile` / `renameFile` calls through to the corresponding
// workspace method best-effort. The disk shape is a derived view of
// the Yjs file tree; a mirror failure logs and is swallowed because
// the runCompile loop in `server.ts` re-writes every file before
// the next compile, so a transient disk error self-heals on the
// next compile cycle.
//
// **In-place edit mirror (M23.5).** Structural ops cover create /
// delete / rename, but a client's keystroke on `sec1.tex` arrives
// as a `Y.Doc` update applied via `Y.applyUpdate(doc, update,
// origin)` — no persistence op fires, so the disk file would stay
// stale until the next time the file was uploaded or renamed.
// For every non-main file we subscribe a `Y.Text.observe` handler
// that schedules a coalesced workspace `writeFile` on remote edits
// (`event.transaction.local === false`). Local-origin transactions
// (this module's own `doc.transact` calls inside `addFile` /
// `renameFile` / hydration) are skipped — the structural mirror
// path already handles those. Rapid edits collapse: at most one
// in-flight write and one queued write per file, with the queued
// write reading the latest `Y.Text` contents at run time.
//
// The race that bit the M23.2 "(A)" candidate (compile-time
// `for (file of files()) writeFile` resurrecting a concurrently
// deleted file) does not apply here: `deleteFile` /
// `renameFile(old)` unsubscribe the observer and `await` the
// in-flight write chain before invoking the workspace's structural
// op, so the disk-level write→delete order is strict.

import * as Y from "yjs";

import type { BlobStore } from "@tex-center/blobs";
import { LocalFsBlobStore } from "@tex-center/blobs";

import {
  MAIN_DOC_HELLO_WORLD,
  MAIN_DOC_NAME,
  validateProjectFileName,
} from "@tex-center/protocol";

import { errorMessage } from "./errors.js";
import type { ProjectWorkspace } from "./workspace.js";

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
 * Blob-store key for a named project file. The canonical key shape
 * for every source file under `projects/<id>/files/`. Callers must
 * pass a single path segment; this helper does not validate.
 */
export function projectFileKey(projectId: string, name: string): string {
  return `${projectFilesDir(projectId)}/${name}`;
}

/**
 * Blob-store key for the canonical source of a project's main file.
 */
export function mainTexKey(projectId: string): string {
  return projectFileKey(projectId, MAIN_DOC_NAME);
}

/**
 * Blob-store key for a project's serialised compiler checkpoint
 * (M7.4). The bytes are produced by `Compiler.snapshot()` and
 * consumed by `Compiler.restore()`; the sidecar treats the
 * contents as opaque.
 *
 * Kept under `projects/<id>/` (not `files/`) so listing source
 * files for the file-tree never surfaces the checkpoint, and so
 * deleting source files can never accidentally invalidate a
 * stored checkpoint key.
 */
export function projectCheckpointKey(projectId: string): string {
  return `projects/${projectId}/checkpoint.bin`;
}

/**
 * Persist a checkpoint blob produced by `Compiler.snapshot()`.
 * No-op when `bytes` is `null` (compiler had no resumable state)
 * or zero-length (defensive — equivalent to no checkpoint).
 * Errors propagate to the caller, which decides whether to log
 * or surface; the sidecar's idle-stop path logs and continues.
 */
export async function persistCheckpoint(
  blobStore: BlobStore,
  projectId: string,
  bytes: Uint8Array | null,
): Promise<void> {
  if (bytes === null || bytes.length === 0) return;
  await blobStore.put(projectCheckpointKey(projectId), bytes);
}

/**
 * Load a previously persisted checkpoint blob. Returns `null`
 * when no checkpoint exists for the project. A blob-store
 * `get` failure propagates — callers in the cold-start path
 * should catch and fall through to a clean rebuild rather than
 * blocking the first compile on a transient outage.
 */
export async function loadCheckpoint(
  blobStore: BlobStore,
  projectId: string,
): Promise<Uint8Array | null> {
  const bytes = await blobStore.get(projectCheckpointKey(projectId));
  if (!bytes || bytes.length === 0) return null;
  return bytes;
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

/**
 * Result of a mutating file-op (`addFile` / `deleteFile` /
 * `renameFile`). Uniform shape so `server.ts` can branch on
 * `result.ok` without per-op casts.
 */
export type FileOpResult = { ok: true } | { ok: false; reason: string };

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
   * PUTs a blob carrying `content` (default `""`) so the file
   * survives a session restart even if the user never edits it.
   *
   * When `content` is non-empty, the file's `Y.Text` is populated
   * inside a `doc.transact` so observers see one coherent update.
   * Used by both the empty-create path (`create-file`) and the
   * upload-from-disk path (`upload-file`).
   *
   * Returns `{ ok: true }` on success, otherwise
   * `{ ok: false, reason }` with a short human-readable reason.
   * The in-memory `knownFiles` set is only mutated on success.
   */
  addFile(name: string, content?: string): Promise<FileOpResult>;
  /**
   * Delete a project file. Rejects `MAIN_DOC_NAME` (never removable;
   * the project always has a main entry) and any name not currently
   * in `files()`. Clears the file's `Y.Text` contents in-place
   * (Y.Doc has no remove-type primitive), removes it from
   * `knownFiles` so `maybePersist` no longer touches the key, and —
   * when the blob store is wired and hydration succeeded — deletes
   * the blob.
   *
   * Returns `{ ok: true }` on success, otherwise
   * `{ ok: false, reason }`. The in-memory state is only mutated
   * on success.
   */
  deleteFile(name: string): Promise<FileOpResult>;
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
  renameFile(oldName: string, newName: string): Promise<FileOpResult>;
}

export function createProjectPersistence(args: {
  blobStore: BlobStore | undefined;
  projectId: string;
  doc: Y.Doc;
  log: PersistenceLogger;
  /**
   * M15 Step D: override for the fresh-project `main.tex` seed.
   * Consulted exactly once, on first hydration, only when no
   * `main.tex` blob exists yet. When omitted (the production
   * default), `MAIN_DOC_HELLO_WORLD` is used — preserving the
   * canonical 4-line template UX contract from iter 167.
   *
   * Used today by the gold suite to materialise a deterministic
   * multi-page source with zero editing keystrokes (`apps/web`'s
   * upstream resolver bakes the seed into the per-project
   * Machine's env at creation time, sourced from
   * `projects.seed_doc`).
   */
  seedMainDoc?: string;
  /**
   * M23.2 workspace mirror. When provided, every successful file
   * mutation (`addFile` / `deleteFile` / `renameFile`) is followed
   * by a best-effort call to the matching `ProjectWorkspace`
   * method so the on-disk scratch dir tracks the Yjs-backed file
   * tree. The mirror is best-effort: a workspace failure logs and
   * is swallowed — Yjs remains source of truth, and the
   * runCompile loop in `server.ts` re-writes every file before
   * the next compile so a transient mirror failure self-heals.
   *
   * `main.tex` itself is *not* mirrored from here — `runCompile`
   * owns `writeMain(source)` on every compile cycle and that
   * remains load-bearing (no Y.Text.observe wire needed for it).
   */
  workspace?: ProjectWorkspace;
}): ProjectPersistence {
  const { blobStore, projectId, doc, log, workspace } = args;
  const seedSource = args.seedMainDoc ?? MAIN_DOC_HELLO_WORLD;

  // Best-effort workspace mirror: logs a warn on failure but never
  // throws. Yjs is the source of truth; the next runCompile cycle
  // re-writes every file from `persistence.files()`, so a transient
  // disk error self-heals.
  async function mirror(action: string, fn: () => Promise<void>): Promise<void> {
    if (!workspace) return;
    try {
      await fn();
    } catch (e) {
      log.warn(
        { err: errorMessage(e), projectId },
        `workspace mirror failed: ${action}`,
      );
    }
  }

  // M23.5 in-place edit mirror. `observers[name]` is the
  // `text.unobserve(handler)` thunk for the per-file Y.Text
  // observer. `writeInFlight[name]` is the currently-running
  // observe-write chain. `pendingObserveWrite` flags names whose
  // Y.Text has changed since the last drain; the chain's loop
  // re-reads `doc.getText(name).toString()` on each iteration so a
  // burst of edits coalesces into at most one in-flight write +
  // one queued write per file.
  const observers = new Map<string, () => void>();
  const writeInFlight = new Map<string, Promise<void>>();
  const pendingObserveWrite = new Set<string>();

  function scheduleObserveWrite(name: string): void {
    if (!workspace) return;
    pendingObserveWrite.add(name);
    if (writeInFlight.has(name)) return;
    const run = async (): Promise<void> => {
      try {
        while (pendingObserveWrite.has(name)) {
          pendingObserveWrite.delete(name);
          const body = doc.getText(name).toString();
          await mirror(
            `observe writeFile(${name})`,
            () => workspace!.writeFile(name, body),
          );
        }
      } finally {
        writeInFlight.delete(name);
      }
    };
    writeInFlight.set(name, run());
  }

  function subscribeObserve(name: string): void {
    if (!workspace) return;
    if (name === MAIN_DOC_NAME) return; // main.tex is mirrored by runCompile
    if (observers.has(name)) return;
    const text = doc.getText(name);
    const handler = (event: Y.YTextEvent): void => {
      // Skip local-origin transactions: our own doc.transact calls
      // (addFile body insert, renameFile copy, deleteFile clear,
      // hydration insert) already drive the disk via the structural
      // mirror path. Only remote (client-applied) updates need to
      // schedule a write here.
      if (event.transaction.local) return;
      scheduleObserveWrite(name);
    };
    text.observe(handler);
    observers.set(name, () => text.unobserve(handler));
  }

  function unsubscribeObserve(name: string): void {
    const unsub = observers.get(name);
    if (!unsub) return;
    unsub();
    observers.delete(name);
  }

  async function flushObserveWrites(name: string): Promise<void> {
    const inFlight = writeInFlight.get(name);
    if (inFlight) await inFlight;
  }

  // Files we are willing to track. Pre-seeded with `MAIN_DOC_NAME`
  // so `files()` exposes a sensible list even if hydration fails;
  // hydration adds every listed blob key.
  const knownFiles = new Set<string>([MAIN_DOC_NAME]);
  // Last-persisted source per file. Absence means "no blob known
  // yet" — the next `maybePersist` will create one even if the
  // current `Y.Text` is empty, preserving the historical
  // "first-compile establishes main.tex" semantics. Unused when
  // `blobStore` is undefined.
  const persistedByName = new Map<string, string>();
  // `true` once blob hydration completed without throwing. Gates
  // every blob-op path; in-memory mode (`blobStore === undefined`)
  // leaves this false and skips all blob ops while still mutating
  // `knownFiles` and the Y.Doc.
  let canPersist = false;

  const hydrated: Promise<void> = (async () => {
    if (!blobStore) {
      // In-memory mode: seed `seedSource` so a brand-new project
      // opens onto a non-empty document. Guard against re-seeding
      // a doc that already has main.tex content (tests sometimes
      // pre-populate the Y.Doc).
      const t = doc.getText(MAIN_DOC_NAME);
      if (t.length === 0) t.insert(0, seedSource);
      // `canPersist` stays false: blob-op paths are gated on it,
      // and there is no blob store to talk to. In-memory addFile
      // / deleteFile / renameFile still mutate `knownFiles` and
      // the Y.Doc, which is the entire contract here.
      return;
    }
    try {
      const files = await listProjectFiles(blobStore, projectId);
      // Bulk-load every file into its own Y.Text inside a single
      // transaction so observers see one coherent update rather
      // than one per file.
      const dec = new TextDecoder();
      const loaded = await Promise.all(
        files.map(async (name) => ({
          name,
          bytes: await blobStore.get(projectFileKey(projectId, name)),
        })),
      );
      // A brand-new project has no `main.tex` blob; seed the
      // canonical 4-line hello-world template so the editor opens
      // onto something meaningful and the first compile produces
      // a non-empty PDF. We do this only when *no* main.tex blob
      // exists at all — an existing-but-empty blob is a legitimate
      // user state ("I cleared the document") and must not be
      // clobbered.
      const hasMainBlob = loaded.some(
        ({ name, bytes }) => name === MAIN_DOC_NAME && bytes !== null,
      );
      doc.transact(() => {
        for (const { name, bytes } of loaded) {
          if (!bytes || bytes.length === 0) continue;
          const t = doc.getText(name);
          if (t.length === 0) t.insert(0, dec.decode(bytes));
        }
        if (!hasMainBlob) {
          const t = doc.getText(MAIN_DOC_NAME);
          if (t.length === 0) t.insert(0, seedSource);
        }
      });
      for (const { name, bytes } of loaded) {
        knownFiles.add(name);
        // An existing-but-empty blob counts as persisted-as-"".
        // A `get` returning `null` (unlikely from `list` output, but
        // tolerated) leaves the entry unset so the next compile
        // re-establishes it.
        if (bytes) persistedByName.set(name, dec.decode(bytes));
        // M23.2 cold-boot rehydration: mirror every non-main file
        // to the on-disk workspace before `awaitHydrated()` resolves
        // so `\input{sec1}` resolves against the supertex daemon's
        // `cwd: workDir` on the first compile. `main.tex` is written
        // on every compile cycle by `runCompile.writeMain`, so we
        // skip it here. Best-effort: a workspace failure logs and
        // is swallowed.
        if (name !== MAIN_DOC_NAME && bytes) {
          await mirror(
            `hydrate writeFile(${name})`,
            () => workspace!.writeFile(name, dec.decode(bytes)),
          );
          subscribeObserve(name);
        }
      }
      if (!hasMainBlob) {
        // Persist the seed immediately so subsequent hydrations
        // (after process restart, machine bounce) see the same
        // bytes rather than re-seeding from scratch. `persistedByName`
        // is left unset so `maybePersist` correctly mirrors any
        // user edit on top of the seed; the blob is already
        // authoritative for the seed-only state.
        try {
          await blobStore.put(
            mainTexKey(projectId),
            new TextEncoder().encode(seedSource),
          );
          persistedByName.set(MAIN_DOC_NAME, seedSource);
        } catch (e) {
          log.warn(
            { err: errorMessage(e), projectId },
            "main.tex seed PUT failed; in-memory seed only this session",
          );
        }
      }
      canPersist = true;
    } catch (e) {
      log.warn(
        { err: errorMessage(e), projectId },
        "blob hydration failed; persistence disabled this session",
      );
    }
  })();

  return {
    awaitHydrated: () => hydrated,
    files: () => Array.from(knownFiles).sort(),
    async addFile(name, content): Promise<FileOpResult> {
      const reason = validateProjectFileName(name);
      if (reason) return { ok: false, reason };
      if (knownFiles.has(name)) return { ok: false, reason: "already exists" };
      const body = content ?? "";
      if (canPersist && blobStore) {
        try {
          await blobStore.put(
            projectFileKey(projectId, name),
            new TextEncoder().encode(body),
          );
          persistedByName.set(name, body);
        } catch (e) {
          log.warn(
            { err: errorMessage(e), projectId },
            `blob create failed for ${name}`,
          );
          return { ok: false, reason: "blob create failed" };
        }
      }
      if (body.length > 0) {
        doc.transact(() => {
          const t = doc.getText(name);
          if (t.length === 0) t.insert(0, body);
        });
      }
      knownFiles.add(name);
      await mirror(`writeFile(${name})`, () => workspace!.writeFile(name, body));
      subscribeObserve(name);
      return { ok: true };
    },
    async deleteFile(name): Promise<FileOpResult> {
      if (name === MAIN_DOC_NAME) return { ok: false, reason: "cannot delete main" };
      if (!knownFiles.has(name)) return { ok: false, reason: "no such file" };
      if (canPersist && blobStore) {
        try {
          await blobStore.delete(projectFileKey(projectId, name));
        } catch (e) {
          log.warn(
            { err: errorMessage(e), projectId },
            `blob delete failed for ${name}`,
          );
          return { ok: false, reason: "blob delete failed" };
        }
      }
      // Stop observing BEFORE the Y.Text clear / workspace delete so a
      // concurrent client edit can't schedule a fresh write that
      // races the workspace.deleteFile and resurrects the file on
      // disk. Drain any already-scheduled write so the disk-level
      // ordering is strict write→delete.
      unsubscribeObserve(name);
      await flushObserveWrites(name);
      const t = doc.getText(name);
      if (t.length > 0) t.delete(0, t.length);
      knownFiles.delete(name);
      persistedByName.delete(name);
      await mirror(`deleteFile(${name})`, () => workspace!.deleteFile(name));
      return { ok: true };
    },
    async renameFile(oldName, newName): Promise<FileOpResult> {
      if (oldName === MAIN_DOC_NAME) return { ok: false, reason: "cannot rename main" };
      if (newName === MAIN_DOC_NAME) return { ok: false, reason: "cannot overwrite main" };
      if (!knownFiles.has(oldName)) return { ok: false, reason: "no such file" };
      const reason = validateProjectFileName(newName);
      if (reason) return { ok: false, reason };
      if (knownFiles.has(newName)) return { ok: false, reason: "already exists" };
      const oldText = doc.getText(oldName);
      const contents = oldText.toString();
      if (canPersist && blobStore) {
        try {
          await blobStore.put(
            projectFileKey(projectId, newName),
            new TextEncoder().encode(contents),
          );
        } catch (e) {
          log.warn(
            { err: errorMessage(e), projectId },
            `blob rename PUT failed for ${newName}`,
          );
          return { ok: false, reason: "blob create failed" };
        }
        try {
          await blobStore.delete(projectFileKey(projectId, oldName));
        } catch (e) {
          // New key is already written and in-memory truth will
          // move to it; orphan the old blob rather than rolling
          // back (a rollback could fail too and leave both keys
          // populated, which is worse).
          log.warn(
            { err: errorMessage(e), projectId },
            `blob rename DELETE failed for ${oldName} (orphaned)`,
          );
        }
        persistedByName.set(newName, contents);
        persistedByName.delete(oldName);
      }
      // Stop observing the old name and drain its in-flight write
      // chain before the workspace rename: an observe-write that
      // landed after the rename would resurrect the old path. The
      // new-name subscription is registered after the structural
      // mirror completes so future remote edits to the renamed file
      // hit disk via observe.
      unsubscribeObserve(oldName);
      await flushObserveWrites(oldName);
      doc.transact(() => {
        const newText = doc.getText(newName);
        if (newText.length === 0 && contents.length > 0) newText.insert(0, contents);
        if (oldText.length > 0) oldText.delete(0, oldText.length);
      });
      knownFiles.delete(oldName);
      knownFiles.add(newName);
      await mirror(
        `renameFile(${oldName}→${newName})`,
        () => workspace!.renameFile(oldName, newName),
      );
      subscribeObserve(newName);
      return { ok: true };
    },
    async maybePersist(): Promise<void> {
      if (!canPersist || !blobStore) return;
      const enc = new TextEncoder();
      for (const name of knownFiles) {
        const source = doc.getText(name).toString();
        if (persistedByName.get(name) === source) continue;
        try {
          await blobStore.put(projectFileKey(projectId, name), enc.encode(source));
          persistedByName.set(name, source);
        } catch (e) {
          log.warn(
            { err: errorMessage(e), projectId },
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
