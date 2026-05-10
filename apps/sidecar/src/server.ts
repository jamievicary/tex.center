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
import { LocalFsBlobStore, type BlobStore } from "@tex-center/blobs";

declare module "fastify" {
  interface FastifyInstance {
    db: DbHandle | null;
  }
}

import type { Compiler } from "./compiler/types.js";
import { FixtureCompiler } from "./compiler/fixture.js";
import { SupertexOnceCompiler } from "./compiler/supertexOnce.js";
import { SupertexWatchCompiler } from "./compiler/supertexWatch.js";
import { detectSupertexFeatures, type SupertexFeatures } from "./compiler/featureDetect.js";
import { ProjectWorkspace } from "./workspace.js";

const COMPILE_DEBOUNCE_MS = 100;

interface ProjectState {
  id: string;
  doc: Y.Doc;
  text: Y.Text;
  viewers: Set<ProjectClient>;
  compileTimer: NodeJS.Timeout | null;
  compiler: Compiler;
  workspace: ProjectWorkspace;
  /** Last source persisted to the blob store; used to skip no-op writes. */
  persistedSource: string | null;
  hydrated: Promise<void>;
}

/**
 * Blob-store key for the canonical source of a project's main file.
 * Today there's only `main.tex`; once multi-file projects land
 * (post-MVP), this becomes a directory listing.
 */
function mainTexKey(projectId: string): string {
  return `projects/${projectId}/files/main.tex`;
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
  const compilerFactory = opts.compilerFactory ?? (await defaultCompilerFactory(fixturePath));

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
    const state: ProjectState = {
      id,
      doc,
      text,
      viewers: new Set(),
      compileTimer: null,
      compiler: compilerFactory({ projectId: id, workspace }),
      workspace,
      persistedSource: null,
      hydrated: Promise.resolve(),
    };
    if (blobStore) {
      state.hydrated = (async () => {
        try {
          const bytes = await blobStore.get(mainTexKey(id));
          if (bytes && bytes.length > 0) {
            const source = new TextDecoder().decode(bytes);
            text.insert(0, source);
            state.persistedSource = source;
          } else if (bytes) {
            state.persistedSource = "";
          }
        } catch (e) {
          app.log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId: id },
            "blob hydration failed",
          );
        }
      })();
    }
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
    await p.hydrated;
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
    if (blobStore && source !== p.persistedSource) {
      try {
        await blobStore.put(mainTexKey(p.id), new TextEncoder().encode(source));
        p.persistedSource = source;
      } catch (e) {
        app.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "blob persist failed",
        );
      }
    }
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
      const projectId = params.projectId ?? "default";
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
      void project.hydrated.then(() => {
        if (socket.readyState !== socket.OPEN) return;
        const initialState = Y.encodeStateAsUpdate(project.doc);
        if (initialState.length > 0) {
          client.send(encodeDocUpdate(initialState));
        }
        scheduleCompile(project);
      });

      const onTextChange = (): void => scheduleCompile(project);
      project.text.observe(onTextChange);

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
        project.text.unobserve(onTextChange);
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

// Selects a default `BlobStore` from environment:
//   - `BLOB_STORE` unset / "none" → null (no persistence)
//   - "local" → `LocalFsBlobStore` rooted at `$BLOB_STORE_LOCAL_DIR`
//   - "s3" → reserved for M4.3.1; rejected for now
function defaultBlobStoreFromEnv(): BlobStore | undefined {
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

// Selects the compiler implementation based on `$SIDECAR_COMPILER`:
//   - unset / "fixture"       → FixtureCompiler (default)
//   - "supertex-once"         → SupertexOnceCompiler, spawning the
//                               binary at `$SUPERTEX_BIN` (required).
//   - "supertex-watch"        → SupertexWatchCompiler, one persistent
//                               watch process per project (M3.3).
//                               Requires upstream READY-marker support
//                               (M3.5) before it can be used against
//                               real `vendor/supertex`.
// Anything else is rejected loudly so deploy-time typos don't
// silently fall back to the fixture path.
async function defaultCompilerFactory(
  fixturePath: string,
): Promise<(ctx: CompilerContext) => Compiler> {
  const which = process.env.SIDECAR_COMPILER ?? "fixture";
  if (which === "fixture") {
    return () => new FixtureCompiler(fixturePath);
  }
  if (which === "supertex-once" || which === "supertex-watch") {
    const supertexBin = process.env.SUPERTEX_BIN;
    if (!supertexBin) {
      throw new Error(
        `SIDECAR_COMPILER=${which} requires SUPERTEX_BIN to point at a supertex executable`,
      );
    }
    const features: SupertexFeatures = await detectSupertexFeatures(supertexBin);
    if (which === "supertex-once") {
      return (ctx) =>
        new SupertexOnceCompiler({ workDir: ctx.workspace.dir, supertexBin, features });
    }
    return (ctx) =>
      new SupertexWatchCompiler({ workDir: ctx.workspace.dir, supertexBin, features });
  }
  throw new Error(`unknown SIDECAR_COMPILER: ${which}`);
}
