// Per-project sidecar server.
//
// Fastify + @fastify/websocket. Holds an in-memory Yjs Y.Doc per
// project. Browsers connect over WebSocket and exchange:
//   - Yjs doc updates (tag 0x00),
//   - control JSON (tag 0x10) — `view` page changes, `hello`,
//     `compile-status`,
//   - server-pushed PDF segments (tag 0x20).
//
// The "compile loop" is currently a stub: any change to the
// project's primary `Y.Text` triggers a debounced shipment of
// the static fixture PDF as a single full-buffer segment. The
// stub stands in until M3 wires real supertex.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import * as Y from "yjs";

import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeControl,
  encodeDocUpdate,
  encodePdfSegment,
} from "@tex-center/protocol";

const COMPILE_DEBOUNCE_MS = 100;

interface ProjectState {
  doc: Y.Doc;
  text: Y.Text;
  viewers: Set<ProjectClient>;
  compileTimer: NodeJS.Timeout | null;
  fixturePdf: Uint8Array | null;
}

interface ProjectClient {
  send: (frame: Uint8Array) => void;
  viewingPage: number;
}

export interface SidecarOptions {
  fixturePdfPath?: string;
  logger?: boolean;
}

export async function buildServer(opts: SidecarOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocketPlugin);

  const fixturePath =
    opts.fixturePdfPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/hello.pdf");

  const projects = new Map<string, ProjectState>();

  function getProject(id: string): ProjectState {
    let p = projects.get(id);
    if (p) return p;
    const doc = new Y.Doc();
    const text = doc.getText("main.tex");
    p = {
      doc,
      text,
      viewers: new Set(),
      compileTimer: null,
      fixturePdf: null,
    };
    projects.set(id, p);
    return p;
  }

  async function loadFixture(p: ProjectState): Promise<Uint8Array> {
    if (p.fixturePdf) return p.fixturePdf;
    const buf = await readFile(fixturePath);
    p.fixturePdf = new Uint8Array(buf);
    return p.fixturePdf;
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

  async function runCompile(p: ProjectState): Promise<void> {
    broadcast(p, encodeControl({ type: "compile-status", state: "running" }));
    try {
      const pdf = await loadFixture(p);
      const frame = encodePdfSegment({
        totalLength: pdf.length,
        offset: 0,
        bytes: pdf,
      });
      broadcast(p, frame);
      broadcast(p, encodeControl({ type: "compile-status", state: "idle" }));
    } catch (e) {
      broadcast(
        p,
        encodeControl({
          type: "compile-status",
          state: "error",
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
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
      p.doc.destroy();
    }
    projects.clear();
  });

  return app;
}
