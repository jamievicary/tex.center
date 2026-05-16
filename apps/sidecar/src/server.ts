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
import { createHash } from "node:crypto";

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
import { errorMessage } from "./errors.js";
import {
  createProjectPersistence,
  defaultBlobStoreFromEnv,
  loadCheckpoint,
  persistCheckpoint,
  type FileOpResult,
  type ProjectPersistence,
} from "./persistence.js";

const COMPILE_DEBOUNCE_MS = 100;
const END_DOCUMENT_BYTES = Buffer.from("\\end{document}", "utf8");

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

/**
 * Structured-log sink for M15 compile diagnostics. `fields` is a
 * record of structured properties; `msg` is the log-record name
 * used for filtering (`compile-source`, `daemon-stdin`,
 * `daemon-stderr`). Shape mirrors pino's `info(obj, msg)` so the
 * production binding is `app.log.info.bind(app.log)`. Tests pass
 * a recorder. `undefined` means logging is disabled — both server
 * and compiler stay silent.
 */
export type CompileDebugLog = (
  fields: Record<string, unknown>,
  msg: string,
) => void;

export interface CompilerContext {
  projectId: string;
  workspace: ProjectWorkspace;
  log?: CompileDebugLog;
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
   * M15 Step A: structured-log sink for compile diagnostics. When
   * supplied (or env `DEBUG_COMPILE_LOG` is unset / not "0" / not
   * "false"), `runCompile` emits a `compile-source` record per
   * compile and the supertex daemon emits `daemon-stdin` /
   * `daemon-stderr` records. Production wiring goes through
   * `app.log.info`; tests pass a recorder.
   */
  compileDebugLog?: CompileDebugLog;
  /**
   * M20.1 two-stage idle cascade. Two independent timers arm when
   * `viewerCount` transitions to zero (and on cold boot, until the
   * first viewer arrives); first re-connection clears both.
   *
   * `suspendTimeoutMs` (default wiring `SIDECAR_SUSPEND_MS=5_000`)
   * is the short stage: production wires it to a Fly machines-API
   * suspend, which freezes RAM and resumes in ~300 ms. Failure on
   * this stage is non-fatal — the handler logs and re-arms; the
   * later `stopTimeoutMs` stage is the failsafe.
   *
   * `stopTimeoutMs` (default wiring `SIDECAR_STOP_MS=300_000`) is
   * the long stage: production wires it to
   * `app.close().then(() => process.exit(0))`, which parks the
   * Machine in `stopped` for cold-load on the next wake. With
   * `restart: on-failure` on the Machine config, a clean exit is
   * required.
   *
   * Each timer is independently enabled (its `*-TimeoutMs` > 0 and
   * its `on*` handler set). Persisting checkpoints happens before
   * either handler runs.
   */
  suspendTimeoutMs?: number;
  onSuspend?: (ctx: { rearm: () => void }) => void;
  stopTimeoutMs?: number;
  onStop?: (ctx: { rearm: () => void }) => void;
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

  // M15 Step A. Default-on while M15's `verifyLivePdfMultiPage` is
  // RED so a live deploy emits per-compile source diagnostics
  // queryable via `flyctl logs`. Off only when DEBUG_COMPILE_LOG is
  // explicitly "0" or "false" (case-insensitive). Test callers
  // override by passing `compileDebugLog` directly.
  const envFlag = (process.env.DEBUG_COMPILE_LOG ?? "").toLowerCase();
  const debugFromEnv = envFlag !== "0" && envFlag !== "false";
  const compileDebugLog: CompileDebugLog | undefined =
    opts.compileDebugLog ??
    (debugFromEnv
      ? (fields, msg) => app.log.info(fields, msg)
      : undefined);

  // M15 Step D: optional override for the fresh-project seed,
  // populated by the per-project upstream resolver from
  // `projects.seed_doc` and passed as a base64-encoded env var on
  // Machine creation. Decoded once at boot. Empty string (or
  // unset) → fall through to `MAIN_DOC_HELLO_WORLD`. A decode
  // failure is logged and ignored — the seed override is a
  // best-effort optimisation, not a correctness primitive.
  const seedMainDoc: string | undefined = (() => {
    const raw = process.env.SEED_MAIN_DOC_B64;
    if (!raw) return undefined;
    try {
      return Buffer.from(raw, "base64").toString("utf8");
    } catch (e) {
      app.log.warn(
        { err: errorMessage(e) },
        "SEED_MAIN_DOC_B64 decode failed; using default hello-world seed",
      );
      return undefined;
    }
  })();

  const projects = new Map<string, ProjectState>();

  // M20.1 two-stage idle bookkeeping. `viewerCount` aggregates
  // across every project; both stages arm only when it transitions
  // to zero (or on cold boot until the first viewer arrives) and
  // are cancelled on the first re-connection.
  let viewerCount = 0;

  // A single idle stage owns its timer + `setTimeout` plumbing and
  // exposes `arm` / `clear`. On fire it persists checkpoints
  // (production suspend freezes RAM mid-response, and stop closes
  // the app — the snapshot must be durable before either) then
  // invokes the handler with a `rearm` callback that re-arms only
  // while still idle. A disabled stage (no timeout or no handler)
  // collapses arm/clear to no-ops so callers don't need to branch.
  function createIdleStage(
    name: "Suspend" | "Stop",
    timeoutMs: number | undefined,
    handler:
      | ((ctx: { rearm: () => void }) => void)
      | undefined,
  ): { arm: () => void; clear: () => void } {
    const enabled =
      typeof timeoutMs === "number"
      && timeoutMs > 0
      && typeof handler === "function";
    if (!enabled) {
      return { arm: () => {}, clear: () => {} };
    }
    let timer: NodeJS.Timeout | null = null;
    function clear(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    function arm(): void {
      clear();
      // M20.3 iter-342 diagnostic: trace timer arming so the
      // production log records whether a given suspend/stop fire was
      // preceded by a cold-boot arm, a 1→0 disconnect arm, or a
      // re-arm from the handler. Pairs with the `viewer-*` and
      // `idle-fire` records below.
      app.log.info({ stage: name, ms: timeoutMs }, "idle-arm");
      timer = setTimeout(() => {
        timer = null;
        app.log.info({ stage: name }, "idle-fire");
        void (async () => {
          await persistAllSources();
          await persistAllCheckpoints();
          try {
            handler!({
              rearm: () => {
                if (viewerCount === 0) arm();
              },
            });
          } catch (e) {
            app.log.error(
              { err: errorMessage(e) },
              `on${name} threw`,
            );
          }
        })();
      }, timeoutMs!);
      // Don't pin the event loop just to fire idle handlers.
      timer.unref?.();
    }
    return { arm, clear };
  }

  const suspendStage = createIdleStage(
    "Suspend",
    opts.suspendTimeoutMs,
    opts.onSuspend,
  );
  const stopStage = createIdleStage(
    "Stop",
    opts.stopTimeoutMs,
    opts.onStop,
  );

  function clearIdleTimers(): void {
    suspendStage.clear();
    stopStage.clear();
  }

  // Arm ONLY the stop stage on every idle entry (cold boot AND
  // viewer-disconnect 1→0). Iter 340 forbade suspend-on-cold-boot
  // because the 5 s suspend timer raced the web proxy's 20–60 s
  // worst-case drive-to-started + tcpProbe + WS upgrade chain;
  // iter 343 generalises that invariant after iter 341/342 confirmed
  // GT-9 + GT-6-stopped still RED with the *disconnect* arm intact.
  // The disconnect-arm path is structurally identical: a transient
  // cold-reopen WS open-then-close cycle (proxy retry, brief
  // upstream blip) fires `noteViewerRemoved` before any frame is
  // delivered, the 5 s suspend timer wins the race against the
  // real reconnect, the Machine self-suspends, and the next 6PN
  // dial from the web proxy can't auto-resume a Fly-suspended
  // Machine. The stop stage's longer timer (default 5 min) is the
  // single failsafe for both orphan cold boot and real abandonment.
  //
  // Cost of removing fast-suspend-on-tab-close: a closed-tab
  // Machine stays `started` (RAM allocated) until the stop timer
  // fires instead of the suspend timer. Future work (`tab-close
  // wire signal` in FUTURE_IDEAS) will re-introduce fast suspend
  // gated on an explicit client→server "leaving for good" frame —
  // until then the proxy cannot distinguish "tab closed" from
  // "cold-reopen WS race", so neither can we.
  stopStage.arm();

  function noteViewerAdded(): void {
    viewerCount += 1;
    clearIdleTimers();
    app.log.info({ viewerCount }, "viewer-added");
  }

  function noteViewerRemoved(): void {
    viewerCount -= 1;
    if (viewerCount < 0) viewerCount = 0;
    app.log.info({ viewerCount }, "viewer-removed");
    if (viewerCount === 0) {
      stopStage.arm();
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
      workspace,
      ...(seedMainDoc !== undefined ? { seedMainDoc } : {}),
    });
    const state: ProjectState = {
      id,
      doc,
      text,
      viewers: new Set(),
      compiler: compilerFactory({
        projectId: id,
        workspace,
        ...(compileDebugLog ? { log: compileDebugLog } : {}),
      }),
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
    // M20.3(a) cold-start hook: kick the compiler's one-shot
    // startup work (for the supertex daemon, spawn child +
    // wait for `.fmt` load — ~4.3 s on cold boot) immediately,
    // so it overlaps with the ~1 s of WS handshake + Yjs
    // hydrate + checkpoint restore that `runCompile` would
    // otherwise serialise behind it. Fire-and-forget: the
    // first `compile()` re-awaits the same cached promise via
    // `ensureReady()`. Errors here are non-fatal — log and
    // continue; the dead-child detect/respawn path in
    // `SupertexDaemonCompiler.compile()` recovers on the next
    // round.
    //
    // M20.3(a)3: `workspace.init()` lays down an empty `main.tex`
    // placeholder so the daemon's spawn doesn't immediately error
    // on a missing source file. Without this gate, on a fresh-
    // project cold start the warmup child died, the iter-331
    // overlap was forfeit, and the first `runCompile` paid full
    // `.fmt`-load latency through the respawn fallback.
    state.workspace
      .init()
      .then(() => state.compiler.warmup())
      .catch((err: unknown) => {
        app.log.warn(
          { err: errorMessage(err), projectId: id },
          "compiler warmup failed; will retry on first compile",
        );
      });
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
    // M20.3(a)2: skip the cold-boot checkpoint GET entirely when
    // the compiler has nothing to restore. Saves ~0.27 s wallclock
    // per cold boot against Tigris/`fra`; flip the flag to `true`
    // on the compiler once upstream supertex exposes a serialise
    // wire (M7.4.2).
    if (!p.compiler.supportsCheckpoint) return Promise.resolve();
    if (!p.restorePromise) {
      p.restorePromise = (async () => {
        try {
          const blob = await loadCheckpoint(blobStore, p.id);
          if (blob) await p.compiler.restore(blob);
        } catch (e) {
          app.log.warn(
            { err: errorMessage(e), projectId: p.id },
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
      // M20.3(a)2: skip the snapshot + PUT entirely when the
      // compiler has no resumable state. Mirrors the
      // `ensureRestored` short-circuit so a non-snapshotting
      // compiler pays zero round-trips on idle-stop either.
      if (!p.compiler.supportsCheckpoint) continue;
      try {
        const bytes = await p.compiler.snapshot();
        await persistCheckpoint(blobStore, p.id, bytes);
      } catch (e) {
        app.log.warn(
          { err: errorMessage(e), projectId: p.id },
          "checkpoint persist failed",
        );
      }
    }
  }

  // M20.3 GT-9 fix (iter 345). Flush every project's Y.Doc source
  // to its persistence layer. Symmetric with
  // `persistAllCheckpoints`. Used on idle-fire and Fastify
  // `onClose` so the soft-shutdown paths can't lose trailing edits
  // that arrived after the last `runCompile`'s `maybePersist`.
  async function persistAllSources(): Promise<void> {
    for (const p of projects.values()) {
      try {
        await p.persistence.maybePersist();
      } catch (e) {
        app.log.warn(
          { err: errorMessage(e), projectId: p.id },
          "source persist on shutdown failed",
        );
      }
    }
  }

  async function runCompile(p: ProjectState): Promise<void> {
    // M20.3 cold-start instrumentation. Bookend every awaited phase
    // so the success-path log line carries per-phase ms. The hydrate
    // and restore promises are one-shot per project, so the first
    // compile shows their real cold-boot cost and subsequent compiles
    // show ~0 — exactly the slicing needed to identify the dominant
    // term.
    const tHydrateStart = Date.now();
    await p.persistence.awaitHydrated();
    const hydrateMs = Date.now() - tHydrateStart;
    const tRestoreStart = Date.now();
    await ensureRestored(p);
    const restoreMs = Date.now() - tRestoreStart;
    const compileStart = Date.now();
    app.log.info({ projectId: p.id, sourceLen: p.text.length }, "compile start");
    broadcast(p, encodeControl({ type: "compile-status", state: "running" }));
    const source = p.text.toString();
    if (compileDebugLog) {
      const sourceBytes = Buffer.from(source, "utf8");
      const endDocPos = sourceBytes.indexOf(END_DOCUMENT_BYTES);
      const headLen = Math.min(80, sourceBytes.length);
      const tailStart = Math.max(0, sourceBytes.length - 80);
      compileDebugLog(
        {
          projectId: p.id,
          sourceLen: source.length,
          sourceBytes: sourceBytes.length,
          sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
          sourceHead: sourceBytes.subarray(0, headLen).toString("utf8"),
          sourceTail: sourceBytes.subarray(tailStart).toString("utf8"),
          endDocPos,
        },
        "compile-source",
      );
    }
    // Mirror current source to the on-disk workspace before
    // compiling. M3.1 lays down the file; the FixtureCompiler
    // ignores it. M3.2+ compilers will read from this path.
    //
    // Non-main files are mirrored from `persistence.ts` itself:
    // structural ops (`addFile`/`deleteFile`/`renameFile`, M23.2)
    // and the hydration block (M23.2) cover create / delete / rename
    // / cold-boot rehydrate; in-place client `Y.Text` edits flow via
    // per-file `Y.Text.observe` subscriptions (M23.5) that schedule
    // a coalesced workspace `writeFile` on every remote update.
    const tWriteMainStart = Date.now();
    try {
      await p.workspace.writeMain(source);
    } catch (e) {
      broadcast(
        p,
        encodeControl({
          type: "compile-status",
          state: "error",
          detail: errorMessage(e),
        }),
      );
      return;
    }
    const writeMainMs = Date.now() - tWriteMainStart;
    // Persist source before invoking the compiler. A failed compile
    // must not lose the user's edits — once the source is on the
    // workspace disk it is also durable in the blob store.
    const tPersistStart = Date.now();
    await p.persistence.maybePersist();
    const persistMs = Date.now() - tPersistStart;
    // targetPage = 0 ⇒ `recompile,end` (every page shipped). The
    // earlier `maxViewingPage(p)` default clamped every compile to
    // page 1 (no viewer ever sets a higher viewingPage until a page-2
    // canvas exists, which depends on page 2 being shipped — M15
    // chicken-and-egg). With "end" the user sees the full document
    // on every compile; the per-page targetPage gate is layered back
    // on later if a long-document perf optimisation is justified.
    const tCompileStart = Date.now();
    const result = await p.compiler.compile({
      source,
      targetPage: 0,
    });
    const compileMs = Date.now() - tCompileStart;
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
        lastSegmentsLen: p.lastSegments.length,
        phases: {
          hydrateMs,
          restoreMs,
          writeMainMs,
          persistMs,
          compileMs,
        },
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
        db = { state: "down", error: errorMessage(e) };
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
        blobs = { state: "down", error: errorMessage(e) };
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
      app.log.info(
        { projectId, viewerCount },
        "ws-upgrade-open",
      );

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
        //
        // Bug B diagnostic (iter 347). The user-reported "compile
        // runs but emits zero pdf-segments on cold-resume" can be
        // any of: (a) lastSegments empty at this point because no
        // prior compile populated it, (b) lastSegments populated
        // but the send loop bailed early, (c) replay shipped but
        // the subsequent compile clobbered it. The log line below
        // makes (a)/(b) discriminable on a single grep, paired with
        // `lastSegmentsLen` on every `compile ok` line.
        let replayBytes = 0;
        let replaySent = 0;
        for (const seg of project.lastSegments) {
          if (socket.readyState !== socket.OPEN) break;
          client.send(encodePdfSegment(seg));
          replayBytes += seg.bytes.byteLength;
          replaySent += 1;
        }
        app.log.info(
          {
            projectId: project.id,
            lastSegmentsLen: project.lastSegments.length,
            replaySent,
            replayBytes,
            socketOpen: socket.readyState === socket.OPEN,
          },
          "replay-segments",
        );
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
            { err: errorMessage(e) },
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

      socket.on("close", (code, reasonBuf) => {
        const hadViewer = project.viewers.has(client);
        const reason =
          reasonBuf && reasonBuf.length > 0
            ? reasonBuf.toString("utf8")
            : "";
        app.log.info(
          { projectId, hadViewer, code, reason },
          "ws-upgrade-close",
        );
        if (!hadViewer) return;
        project.viewers.delete(client);
        noteViewerRemoved();
        project.doc.off("update", onTextChange);
        project.doc.off("update", onDocUpdate);
        if (project.viewers.size === 0) {
          // M20.3 GT-9 fix (iter 345): flush any unpersisted Yjs ops
          // before tearing down the debounce timer. Mechanism — the
          // last in-flight compile's `maybePersist` captures the doc
          // state at compile-start; Yjs ops that arrive *during* that
          // compile set `coalescer.pending=true` and would normally
          // be flushed by a second debounce-fired compile after
          // `.finally`. Cancelling the coalescer here drops that
          // second compile, so the trailing chars in the Y.Doc never
          // make it to the blob. A direct `maybePersist` (which reads
          // the current `Y.Text` state) is the right thing here:
          // identical write to what the next compile would have done,
          // minus the compile itself.
          project.persistence.maybePersist().catch((err) => {
            app.log.warn(
              { err: errorMessage(err), projectId },
              "final maybePersist on viewer-disconnect failed",
            );
          });
          project.coalescer.cancel();
        }
      });
    });
  });

  app.addHook("onClose", async () => {
    clearIdleTimers();
    // M20.3 GT-9 fix (iter 345). Final source flush before tearing
    // down the docs. `createStopHandler` calls `app.close()` on idle
    // stop; any explicit `app.close()` (test cleanup, SIGTERM-driven
    // graceful shutdown) gets the same flush invariant.
    await persistAllSources();
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
      return (ctx) =>
        new SupertexDaemonCompiler({
          workDir: ctx.workspace.dir,
          supertexBin,
          projectId: ctx.projectId,
          ...(ctx.log ? { log: ctx.log } : {}),
        });
    }
    return (ctx) => new SupertexOnceCompiler({ workDir: ctx.workspace.dir, supertexBin });
  }
  throw new Error(`unknown SIDECAR_COMPILER: ${which}`);
}
