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

import type { Compiler } from "./compiler/types.js";
import { FixtureCompiler } from "./compiler/fixture.js";
import { SupertexOnceCompiler } from "./compiler/supertexOnce.js";
import { SupertexWatchCompiler } from "./compiler/supertexWatch.js";
import { detectSupertexFeatures, type SupertexFeatures } from "./compiler/featureDetect.js";
import { ProjectWorkspace } from "./workspace.js";

const COMPILE_DEBOUNCE_MS = 100;

interface ProjectState {
  doc: Y.Doc;
  text: Y.Text;
  viewers: Set<ProjectClient>;
  compileTimer: NodeJS.Timeout | null;
  compiler: Compiler;
  workspace: ProjectWorkspace;
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

  const projects = new Map<string, ProjectState>();

  function getProject(id: string): ProjectState {
    let p = projects.get(id);
    if (p) return p;
    const doc = new Y.Doc();
    const text = doc.getText(MAIN_DOC_NAME);
    const workspace = new ProjectWorkspace({ rootDir: scratchRoot, projectId: id });
    p = {
      doc,
      text,
      viewers: new Set(),
      compileTimer: null,
      compiler: compilerFactory({ projectId: id, workspace }),
      workspace,
    };
    projects.set(id, p);
    return p;
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

  app.get("/healthz", async () => ({ ok: true, protocol: PROTOCOL_VERSION }));

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
      client.send(encodeControl({ type: "hello", protocol: PROTOCOL_VERSION }));
      const initialState = Y.encodeStateAsUpdate(project.doc);
      if (initialState.length > 0) {
        client.send(encodeDocUpdate(initialState));
      }
      scheduleCompile(project);

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
  });

  return app;
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
