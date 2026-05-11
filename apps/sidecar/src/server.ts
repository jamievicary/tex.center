// Per-project sidecar server.
//
// Fastify + @fastify/websocket. Holds an in-memory Yjs Y.Doc per
// project. Browsers connect over WebSocket and exchange:
//   - Yjs doc updates (tag 0x00),
//   - control JSON (tag 0x10) — `view` page changes, `hello`,
//     `compile-status`,
//   - server-pushed PDF segments (tag 0x20).
//
// The compile loop talks to a `Compiler` (see `./compiler/types.ts`).
// Today the only implementation is `FixtureCompiler`, which ships a
// static hello-world PDF irrespective of source. M3 swaps in a
// supertex-backed compiler behind the same seam.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import * as Y from "yjs";

import {
  MAIN_DOC_NAME,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeControl,
  encodeDocUpdate,
  encodePdfSegment,
} from "@tex-center/protocol";
import { createDb, closeDb, type DbHandle } from "@tex-center/db";
import { type BlobStore } from "@tex-center/blobs";

declare module "fastify" {
  interface FastifyInstance {
    db: DbHandle | null;
  }
}

import type { Compiler } from "./compiler/types.js";
import { FixtureCompiler } from "./compiler/fixture.js";
import { SupertexOnceCompiler } from "./compiler/supertexOnce.js";
import { ProjectWorkspace } from "./workspace.js";
import {
  createProjectPersistence,
  defaultBlobStoreFromEnv,
  type ProjectPersistence,
} from "./persistence.js";

const COMPILE_DEBOUNCE_MS = 100;

interface ProjectState {
  id: string;
  doc: Y.Doc;
  text: Y.Text;
  viewers: Set<ProjectClient>;
  compileTimer: NodeJS.Timeout | null;
  compiler: Compiler;
  workspace: ProjectWorkspace;
  persistence: ProjectPersistence;
}

interface ProjectClient {
  send: (frame: Uint8Array) => void;
  viewingPage: number;
}

export interface CompilerContext {
  projectId: string;
  workspace: ProjectWorkspace;
}

export interface SidecarOptions {
  fixturePdfPath?: string;
  compilerFactory?: (ctx: CompilerContext) => Compiler;
  /**
   * Root directory under which per-project scratch dirs live. If
   * omitted, a process-unique tempdir under `os.tmpdir()` is
   * created and removed on `app.close()`.
   */
  scratchRoot?: string;
  logger?: boolean;
  /**
   * Caller-owned database handle. If provided, `buildServer` uses
   * it as-is and does NOT close it on shutdown — the caller's
   * lifecycle wins.
   */
  db?: DbHandle;
  /**
   * Factory used when `db` is unset and `DATABASE_URL` is in the
   * environment. Defaults to `createDb` from `@tex-center/db`.
   * Test seam.
   */
  dbFactory?: (connectionString: string) => DbHandle;
  /**
   * Blob store for project file persistence. If provided,
   * `buildServer` uses it as-is. Otherwise, env (`BLOB_STORE`)
   * selects a default; `unset` means no persistence (in-memory
   * Y.Doc only).
   */
  blobStore?: BlobStore;
}

export async function buildServer(opts: SidecarOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocketPlugin);

  const fixturePath =
    opts.fixturePdfPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/hello.pdf");
  const compilerFactory = opts.compilerFactory ?? defaultCompilerFactory(fixturePath);

  // If the caller didn't supply a scratchRoot, mint one under
  // os.tmpdir() so concurrent sidecar instances (e.g. the test
  // suite) don't collide. The "owned" flag drives full removal
  // on shutdown; an externally-supplied root is left in place.
  const ownedScratchRoot = opts.scratchRoot === undefined;
  const scratchRoot = opts.scratchRoot ?? mkdtempSync(join(tmpdir(), "tex-center-sidecar-"));

  let dbHandle: DbHandle | null = null;
  let ownedDb = false;
  if (opts.db) {
    dbHandle = opts.db;
  } else if (process.env.DATABASE_URL) {
    const factory = opts.dbFactory ?? createDb;
    dbHandle = factory(process.env.DATABASE_URL);
    ownedDb = true;
  }
  app.decorate("db", dbHandle);

  const blobStore = opts.blobStore ?? defaultBlobStoreFromEnv();

  const projects = new Map<string, ProjectState>();

  function getProject(id: string): ProjectState {
    let p = projects.get(id);
    if (p) return p;
    const doc = new Y.Doc();
    const text = doc.getText(MAIN_DOC_NAME);
    const workspace = new ProjectWorkspace({ rootDir: scratchRoot, projectId: id });
    const persistence = createProjectPersistence({
      blobStore,
      projectId: id,
      doc,
      log: app.log,
    });
    const state: ProjectState = {
      id,
      doc,
      text,
      viewers: new Set(),
      compileTimer: null,
      compiler: compilerFactory({ projectId: id, workspace }),
      workspace,
      persistence,
    };
    projects.set(id, state);
    return state;
  }

  function broadcast(p: ProjectState, frame: Uint8Array, except?: ProjectClient): void {
    for (const c of p.viewers) {
      if (c === except) continue;
      c.send(frame);
    }
  }

  function scheduleCompile(p: ProjectState): void {
    if (p.compileTimer) return;
    p.compileTimer = setTimeout(() => {
      p.compileTimer = null;
      void runCompile(p);
    }, COMPILE_DEBOUNCE_MS);
  }

  function maxViewingPage(p: ProjectState): number {
    let max = 1;
    for (const c of p.viewers) {
      if (c.viewingPage > max) max = c.viewingPage;
    }
    return max;
  }

  async function runCompile(p: ProjectState): Promise<void> {
    await p.persistence.awaitHydrated();
    broadcast(p, encodeControl({ type: "compile-status", state: "running" }));
    const source = p.text.toString();
    // Mirror current source to the on-disk workspace before
    // compiling. M3.1 lays down the file; the FixtureCompiler
    // ignores it. M3.2+ compilers will read from this path.
    try {
      await p.workspace.writeMain(source);
    } catch (e) {
      broadcast(
        p,
        encodeControl({
          type: "compile-status",
          state: "error",
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
      return;
    }
    // Persist source before invoking the compiler. A failed compile
    // must not lose the user's edits — once the source is on the
    // workspace disk it is also durable in the blob store.
    await p.persistence.maybePersist();
    const result = await p.compiler.compile({
      source,
      targetPage: maxViewingPage(p),
    });
    if (!result.ok) {
      broadcast(
        p,
        encodeControl({ type: "compile-status", state: "error", detail: result.error }),
      );
      return;
    }
    for (const seg of result.segments) {
      broadcast(p, encodePdfSegment(seg));
    }
    broadcast(p, encodeControl({ type: "compile-status", state: "idle" }));
  }

  app.get("/healthz", async () => {
    let db: { state: "absent" | "up" | "down"; error?: string };
    if (app.db) {
      try {
        await app.db.client`SELECT 1`;
        db = { state: "up" };
      } catch (e) {
        db = { state: "down", error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      db = { state: "absent" };
    }
    let blobs: { state: "absent" | "up" | "down"; error?: string };
    if (blobStore) {
      try {
        await blobStore.health();
        blobs = { state: "up" };
      } catch (e) {
        blobs = { state: "down", error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      blobs = { state: "absent" };
    }
    return {
      ok: db.state !== "down" && blobs.state !== "down",
      protocol: PROTOCOL_VERSION,
      db,
      blobs,
    };
  });

  app.register(async (instance) => {
    instance.get("/ws/project/:projectId", { websocket: true }, (socket, req) => {
      const params = req.params as { projectId?: string };
      const projectId = params.projectId;
      // Reject malformed ids at the edge rather than letting
      // `ProjectWorkspace`'s validator throw inside `getProject`.
      // Allowed shape mirrors the workspace regex so a valid id
      // here is always a valid scratch-dir component.
      if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
        socket.close(1008, "invalid projectId");
        return;
      }
      const project = getProject(projectId);

      const client: ProjectClient = {
        viewingPage: 1,
        send: (frame) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(frame);
          }
        },
      };
      project.viewers.add(client);

      // Greet, then ship current Yjs state and a fresh compile.
      // Hydration may still be in flight; await before snapshotting
      // so the client sees the persisted source on first frame.
      client.send(encodeControl({ type: "hello", protocol: PROTOCOL_VERSION }));
      void project.persistence.awaitHydrated().then(async () => {
        if (socket.readyState !== socket.OPEN) return;
        const initialState = Y.encodeStateAsUpdate(project.doc);
        if (initialState.length > 0) {
          client.send(encodeDocUpdate(initialState));
        }
        // File list comes from persistence: it already ran a `list`
        // during hydration and tracks the canonical set. Falls back
        // to `[MAIN_DOC_NAME]` when no blob store is wired or
        // hydration failed.
        if (socket.readyState !== socket.OPEN) return;
        client.send(
          encodeControl({ type: "file-list", files: project.persistence.files() }),
        );
        scheduleCompile(project);
      });

      // Compile-and-persist must fire on edits to any file's Y.Text,
      // not just `main.tex`, so we listen at the doc level. The
      // debounce in `scheduleCompile` collapses bursts.
      const onTextChange = (): void => scheduleCompile(project);
      project.doc.on("update", onTextChange);

      const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
        if (origin === client) return; // don't echo to sender
        client.send(encodeDocUpdate(update));
      };
      project.doc.on("update", onDocUpdate);

      socket.on("message", (raw: Buffer) => {
        let frame: Uint8Array;
        if (Buffer.isBuffer(raw)) {
          frame = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        } else {
          frame = new Uint8Array(raw as ArrayBuffer);
        }
        let decoded;
        try {
          decoded = decodeFrame(frame);
        } catch (e) {
          app.log.warn(
            { err: e instanceof Error ? e.message : String(e) },
            "bad frame from client",
          );
          return;
        }
        switch (decoded.kind) {
          case "doc-update":
            Y.applyUpdate(project.doc, decoded.update, client);
            break;
          case "control":
            if (decoded.message.type === "view") {
              client.viewingPage = decoded.message.page;
            } else if (decoded.message.type === "create-file") {
              const name = decoded.message.name;
              void project.persistence.addFile(name).then((res) => {
                if (!res.added) {
                  app.log.warn(
                    { name, reason: res.reason, projectId: project.id },
                    "create-file rejected",
                  );
                  client.send(
                    encodeControl({
                      type: "file-op-error",
                      op: "create-file",
                      reason: res.reason,
                    }),
                  );
                  return;
                }
                broadcast(
                  project,
                  encodeControl({ type: "file-list", files: project.persistence.files() }),
                );
              });
            } else if (decoded.message.type === "rename-file") {
              const { oldName, newName } = decoded.message;
              void project.persistence
                .renameFile(oldName, newName)
                .then((res) => {
                  if (!res.renamed) {
                    app.log.warn(
                      { oldName, newName, reason: res.reason, projectId: project.id },
                      "rename-file rejected",
                    );
                    client.send(
                      encodeControl({
                        type: "file-op-error",
                        op: "rename-file",
                        reason: res.reason,
                      }),
                    );
                    return;
                  }
                  broadcast(
                    project,
                    encodeControl({ type: "file-list", files: project.persistence.files() }),
                  );
                });
            } else if (decoded.message.type === "upload-file") {
              const { name, content } = decoded.message;
              void project.persistence.addFile(name, content).then((res) => {
                if (!res.added) {
                  app.log.warn(
                    { name, reason: res.reason, projectId: project.id },
                    "upload-file rejected",
                  );
                  client.send(
                    encodeControl({
                      type: "file-op-error",
                      op: "upload-file",
                      reason: res.reason,
                    }),
                  );
                  return;
                }
                broadcast(
                  project,
                  encodeControl({ type: "file-list", files: project.persistence.files() }),
                );
              });
            } else if (decoded.message.type === "delete-file") {
              const name = decoded.message.name;
              void project.persistence.deleteFile(name).then((res) => {
                if (!res.deleted) {
                  app.log.warn(
                    { name, reason: res.reason, projectId: project.id },
                    "delete-file rejected",
                  );
                  client.send(
                    encodeControl({
                      type: "file-op-error",
                      op: "delete-file",
                      reason: res.reason,
                    }),
                  );
                  return;
                }
                broadcast(
                  project,
                  encodeControl({ type: "file-list", files: project.persistence.files() }),
                );
              });
            }
            break;
          case "awareness":
            // reserved
            break;
          case "pdf-segment":
            // server-only message; ignore from clients
            break;
        }
      });

      socket.on("close", () => {
        project.viewers.delete(client);
        project.doc.off("update", onTextChange);
        project.doc.off("update", onDocUpdate);
        if (project.viewers.size === 0 && project.compileTimer) {
          clearTimeout(project.compileTimer);
          project.compileTimer = null;
        }
      });
    });
  });

  app.addHook("onClose", async () => {
    for (const p of projects.values()) {
      if (p.compileTimer) {
        clearTimeout(p.compileTimer);
        p.compileTimer = null;
      }
      await p.compiler.close();
      await p.workspace.dispose();
      p.doc.destroy();
    }
    projects.clear();
    if (ownedScratchRoot) {
      await rm(scratchRoot, { recursive: true, force: true });
    }
    if (ownedDb && dbHandle) {
      await closeDb(dbHandle);
    }
  });

  return app;
}

// Selects the compiler implementation based on `$SIDECAR_COMPILER`:
//   - unset / "fixture" → FixtureCompiler (default; used by unit
//                         tests and dev without a real supertex).
//   - "supertex"        → SupertexOnceCompiler, spawning the binary
//                         at `$SUPERTEX_BIN` (required) once per
//                         compile request.
// Anything else is rejected loudly so deploy-time typos don't
// silently fall back to the fixture path.
function defaultCompilerFactory(
  fixturePath: string,
): (ctx: CompilerContext) => Compiler {
  const which = process.env.SIDECAR_COMPILER ?? "fixture";
  if (which === "fixture") {
    return () => new FixtureCompiler(fixturePath);
  }
  if (which === "supertex") {
    const supertexBin = process.env.SUPERTEX_BIN;
    if (!supertexBin) {
      throw new Error(
        `SIDECAR_COMPILER=${which} requires SUPERTEX_BIN to point at a supertex executable`,
      );
    }
    return (ctx) => new SupertexOnceCompiler({ workDir: ctx.workspace.dir, supertexBin });
  }
  throw new Error(`unknown SIDECAR_COMPILER: ${which}`);
}
