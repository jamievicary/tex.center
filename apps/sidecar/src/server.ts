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

import type { Compiler, PdfSegment } from "./compiler/types.js";
import { FixtureCompiler } from "./compiler/fixture.js";
import { SupertexOnceCompiler } from "./compiler/supertexOnce.js";
import { SupertexDaemonCompiler } from "./compiler/supertexDaemon.js";
import { ProjectWorkspace } from "./workspace.js";
import { CompileCoalescer, type CompileCoalescerOptions } from "./compileCoalescer.js";
import {
  createProjectPersistence,
  defaultBlobStoreFromEnv,
  loadCheckpoint,
  persistCheckpoint,
  type FileOpResult,
  type ProjectPersistence,
} from "./persistence.js";

const COMPILE_DEBOUNCE_MS = 100;

interface ProjectState {
  id: string;
  doc: Y.Doc;
  text: Y.Text;
  viewers: Set<ProjectClient>;
  compiler: Compiler;
  workspace: ProjectWorkspace;
  persistence: ProjectPersistence;
  /**
   * One-shot cold-start restore for this project's compiler. Lazily
   * initialised on the first `compile()`; subsequent compiles await
   * the same promise so restore happens exactly once per project
   * lifetime. `null` when no blob store is wired (restore is a no-op).
   */
  restorePromise: Promise<void> | null;
  // Edge-triggered compile state machine. See `compileCoalescer.ts`.
  coalescer: CompileCoalescer;
  // Last non-empty PDF segments emitted by `runCompile`. Replayed
  // to a fresh WS subscriber on connect so a viewer arriving after
  // the initial compile (e.g. a gold spec opening a project the
  // warm-up already compiled) sees the current PDF state without
  // requiring an edit. Empty until the first successful, non-no-op
  // compile.
  lastSegments: PdfSegment[];
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
  /**
   * Milliseconds the sidecar should sit with **zero viewers**
   * before invoking `onIdle`. Both must be set for idle-stop to
   * arm; either unset disables the feature (the default for
   * tests). On a per-project Fly Machine the entry point wires
   * `onIdle` to `app.close().then(() => process.exit(0))`; with
   * `restart: on-failure` on the Machine config, a clean exit
   * leaves the Machine in `stopped` state for the next wake.
   */
  idleTimeoutMs?: number;
  onIdle?: () => void;
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

  // Per-iter-222 plan: gated structured trace of every
  // CompileCoalescer state-machine transition. Off by default; flip
  // `SIDECAR_TRACE_COALESCER=1` on a Fly Machine to capture the
  // sequence of `{event,seq,inFlight,pending}` records that leads to
  // the iter-221 "already in flight" toast cluster, then scrape via
  // `flyctl logs`.
  const traceCoalescer = process.env.SIDECAR_TRACE_COALESCER === "1";

  const projects = new Map<string, ProjectState>();

  // Idle-stop bookkeeping. `viewerCount` aggregates across every
  // project; the timer is armed only when it transitions to zero
  // and cancelled on the first re-connection.
  let viewerCount = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  const idleTimeoutMs = opts.idleTimeoutMs;
  const onIdle = opts.onIdle;
  const idleEnabled =
    typeof idleTimeoutMs === "number" && idleTimeoutMs > 0 && typeof onIdle === "function";

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    if (!idleEnabled) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Persist checkpoints before handing off to the user's
      // onIdle callback. The entry point's onIdle calls
      // `app.close()` which destroys per-project state, so any
      // snapshot/persist has to happen first.
      void (async () => {
        await persistAllCheckpoints();
        try {
          onIdle!();
        } catch (e) {
          app.log.error(
            { err: e instanceof Error ? e.message : String(e) },
            "onIdle threw",
          );
        }
      })();
    }, idleTimeoutMs!);
    // Don't pin the event loop just to fire idle-stop.
    idleTimer.unref?.();
  }

  // Arm at startup: a Fly Machine that boots without ever
  // receiving a viewer connection (control-plane wake-probe
  // followed by no WS handshake, or user navigates away
  // mid-cold-start) would otherwise never transition 1→0 and
  // never idle-stop. First viewer-add clears this.
  armIdleTimer();

  function noteViewerAdded(): void {
    viewerCount += 1;
    clearIdleTimer();
  }

  function noteViewerRemoved(): void {
    viewerCount -= 1;
    if (viewerCount < 0) viewerCount = 0;
    if (viewerCount === 0) {
      armIdleTimer();
    }
  }

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
      compiler: compilerFactory({ projectId: id, workspace }),
      workspace,
      persistence,
      restorePromise: null,
      // Late-bound below: `runCompile` needs `state` in scope.
      coalescer: null as unknown as CompileCoalescer,
      lastSegments: [],
    };
    const coalescerOpts: CompileCoalescerOptions = {
      debounceMs: COMPILE_DEBOUNCE_MS,
      run: () => runCompile(state),
    };
    if (traceCoalescer) {
      coalescerOpts.trace = (event) =>
        app.log.info({ projectId: id, coalescer: event }, "coalescer-trace");
    }
    state.coalescer = new CompileCoalescer(coalescerOpts);
    projects.set(id, state);
    return state;
  }

  function broadcast(p: ProjectState, frame: Uint8Array, except?: ProjectClient): void {
    for (const c of p.viewers) {
      if (c === except) continue;
      c.send(frame);
    }
  }

  function maxViewingPage(p: ProjectState): number {
    let max = 1;
    for (const c of p.viewers) {
      if (c.viewingPage > max) max = c.viewingPage;
    }
    return max;
  }

  // Cold-start checkpoint restore. Idempotent per project: the first
  // call kicks off load+restore, every subsequent call awaits the
  // same promise. A failure is logged and swallowed — the next
  // `compile()` rebuilds from scratch, which is the documented
  // fallback for the compiler's `restore()` contract.
  function ensureRestored(p: ProjectState): Promise<void> {
    if (!blobStore) return Promise.resolve();
    if (!p.restorePromise) {
      p.restorePromise = (async () => {
        try {
          const blob = await loadCheckpoint(blobStore, p.id);
          if (blob) await p.compiler.restore(blob);
        } catch (e) {
          app.log.warn(
            { err: e instanceof Error ? e.message : String(e), projectId: p.id },
            "checkpoint restore failed; continuing without restore",
          );
        }
      })();
    }
    return p.restorePromise;
  }

  // Snapshot every project's compiler and persist the resulting
  // blob. Today every concrete compiler returns null, so this is
  // observable only with a fake compiler in tests; the wiring lands
  // now so the daemon-side serialise wire (M7.4.2) needs no further
  // sidecar plumbing. Per-project failures are logged and do not
  // abort the rest — one wedged project must not block idle-stop
  // of the others.
  async function persistAllCheckpoints(): Promise<void> {
    if (!blobStore) return;
    for (const p of projects.values()) {
      try {
        const bytes = await p.compiler.snapshot();
        await persistCheckpoint(blobStore, p.id, bytes);
      } catch (e) {
        app.log.warn(
          { err: e instanceof Error ? e.message : String(e), projectId: p.id },
          "checkpoint persist failed",
        );
      }
    }
  }

  async function runCompile(p: ProjectState): Promise<void> {
    await p.persistence.awaitHydrated();
    await ensureRestored(p);
    const compileStart = Date.now();
    app.log.info({ projectId: p.id, sourceLen: p.text.length }, "compile start");
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
      app.log.warn(
        { projectId: p.id, elapsedMs: Date.now() - compileStart, error: result.error },
        "compile error",
      );
      broadcast(
        p,
        encodeControl({ type: "compile-status", state: "error", detail: result.error }),
      );
      return;
    }
    let bytesShipped = 0;
    for (const seg of result.segments) {
      bytesShipped += seg.bytes.byteLength;
      broadcast(p, encodePdfSegment(seg));
    }
    if (result.segments.length > 0) {
      p.lastSegments = result.segments;
    }
    if (
      typeof result.shipoutPage === "number" &&
      result.shipoutPage > p.coalescer.highestEmittedShipoutPage
    ) {
      p.coalescer.highestEmittedShipoutPage = result.shipoutPage;
    }
    app.log.info(
      {
        projectId: p.id,
        elapsedMs: Date.now() - compileStart,
        segments: result.segments.length,
        bytesShipped,
      },
      "compile ok",
    );
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
      noteViewerAdded();

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
        // Replay the last-emitted PDF segment(s) so a viewer that
        // joins after the initial compile sees the current PDF
        // state without needing an edit. The supertex daemon
        // short-circuits an unchanged-source `recompile` to
        // `{segments: []}`, so without this replay a fresh
        // subscriber on a quiescent project would never receive a
        // pdf-segment frame.
        for (const seg of project.lastSegments) {
          if (socket.readyState !== socket.OPEN) return;
          client.send(encodePdfSegment(seg));
        }
        project.coalescer.kick();
      });

      type FileOp = "create-file" | "rename-file" | "upload-file" | "delete-file";
      function handleFileOp(
        op: FileOp,
        details: Record<string, unknown>,
        promise: Promise<FileOpResult>,
      ): void {
        void promise.then((res) => {
          if (!res.ok) {
            app.log.warn(
              { ...details, reason: res.reason, projectId: project.id },
              `${op} rejected`,
            );
            client.send(encodeControl({ type: "file-op-error", op, reason: res.reason }));
            return;
          }
          broadcast(
            project,
            encodeControl({ type: "file-list", files: project.persistence.files() }),
          );
        });
      }

      // Compile-and-persist must fire on edits to any file's Y.Text,
      // not just `main.tex`, so we listen at the doc level. The
      // coalescer collapses bursts and gates on an in-flight compile
      // so the underlying compiler never sees an overlapping
      // `compile()` call.
      const onTextChange = (): void => project.coalescer.kick();
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
            app.log.info(
              { projectId: project.id, updateBytes: decoded.update.byteLength },
              "client doc-update",
            );
            Y.applyUpdate(project.doc, decoded.update, client);
            break;
          case "control":
            if (decoded.message.type === "view") {
              client.viewingPage = decoded.message.page;
              project.coalescer.kickForView(maxViewingPage(project));
            } else if (decoded.message.type === "create-file") {
              const name = decoded.message.name;
              handleFileOp("create-file", { name }, project.persistence.addFile(name));
            } else if (decoded.message.type === "rename-file") {
              const { oldName, newName } = decoded.message;
              handleFileOp(
                "rename-file",
                { oldName, newName },
                project.persistence.renameFile(oldName, newName),
              );
            } else if (decoded.message.type === "upload-file") {
              const { name, content } = decoded.message;
              handleFileOp(
                "upload-file",
                { name },
                project.persistence.addFile(name, content),
              );
            } else if (decoded.message.type === "delete-file") {
              const name = decoded.message.name;
              handleFileOp(
                "delete-file",
                { name },
                project.persistence.deleteFile(name),
              );
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
        if (!project.viewers.has(client)) return;
        project.viewers.delete(client);
        noteViewerRemoved();
        project.doc.off("update", onTextChange);
        project.doc.off("update", onDocUpdate);
        if (project.viewers.size === 0) {
          project.coalescer.cancel();
        }
      });
    });
  });

  app.addHook("onClose", async () => {
    clearIdleTimer();
    for (const p of projects.values()) {
      p.coalescer.cancel();
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
  if (which === "supertex" || which === "supertex-daemon") {
    const supertexBin = process.env.SUPERTEX_BIN;
    if (!supertexBin) {
      throw new Error(
        `SIDECAR_COMPILER=${which} requires SUPERTEX_BIN to point at a supertex executable`,
      );
    }
    if (which === "supertex-daemon") {
      return (ctx) => new SupertexDaemonCompiler({ workDir: ctx.workspace.dir, supertexBin });
    }
    return (ctx) => new SupertexOnceCompiler({ workDir: ctx.workspace.dir, supertexBin });
  }
  throw new Error(`unknown SIDECAR_COMPILER: ${which}`);
}
