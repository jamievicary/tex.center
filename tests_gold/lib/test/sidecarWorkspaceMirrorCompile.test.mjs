// M23.4 — gold spec: 2-file project compiles end-to-end through the
// cold-boot workspace mirror.
//
// `main.tex` `\input{sec1}`s `sec1.tex`. The sidecar boots cold with
// both files pre-seeded only in the blob store (never via a runtime
// `create-file`/`upload-file` op). M23.2's hydration mirror is the
// load-bearing step: when blob hydration runs it must write every
// non-main file to disk *before* `awaitHydrated()` resolves, so the
// first compile (kicked by the client connecting) sees `sec1.tex` in
// the supertex daemon's `cwd: workDir` and lualatex's kpathsea
// resolves `\input{sec1}` against it.
//
// PASS = a `pdf-segment` frame arrives with a valid `%PDF` header and
// plausible byte size, and no `compile-status state:"error"` frame
// fires. Pre-M23.2, lualatex would error with "File `sec1.tex' not
// found" and no segment would ship.
//
// Skips when the supertex binary or system `lualatex` are absent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SUPERTEX_BIN = resolve(ROOT, "vendor/supertex/build/supertex");

function skip(msg) {
  console.log(`sidecarWorkspaceMirrorCompile.test.mjs: SKIP — ${msg}`);
  process.exit(0);
}

if (!existsSync(SUPERTEX_BIN)) {
  skip(`${SUPERTEX_BIN} not built (run vendor/supertex make)`);
}
const which = spawnSync("which", ["lualatex"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  skip("lualatex not on PATH (install TeX Live)");
}

// Dynamic imports after the skip-gates so a fresh checkout without
// sidecar dependencies installed still completes (with SKIP).
const { SupertexDaemonCompiler } = await import(
  resolve(ROOT, "apps/sidecar/src/compiler/supertexDaemon.ts")
);
const { buildServer } = await import(
  resolve(ROOT, "apps/sidecar/src/server.ts")
);
const { decodeFrame } = await import(
  resolve(ROOT, "packages/protocol/src/index.ts")
);
const { LocalFsBlobStore } = await import(
  resolve(ROOT, "packages/blobs/src/index.ts")
);
const { WebSocket } = await import("ws");

const PROJECT_ID = "00000000-0000-0000-0000-00000000aaaa";

const MAIN_TEX =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "\\input{sec1}\n" +
  "\\end{document}\n";

const SEC1_TEX = "Hello from sec1!\n";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const blobRoot = mkdtempSync(join(tmpdir(), "sidecar-mirror-compile-blob-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-mirror-compile-scratch-"));
  const blobStore = new LocalFsBlobStore({ rootDir: blobRoot });

  await blobStore.put(
    `projects/${PROJECT_ID}/files/main.tex`,
    new TextEncoder().encode(MAIN_TEX),
  );
  await blobStore.put(
    `projects/${PROJECT_ID}/files/sec1.tex`,
    new TextEncoder().encode(SEC1_TEX),
  );

  const app = await buildServer({
    logger: false,
    blobStore,
    scratchRoot,
    compilerFactory: (ctx) =>
      new SupertexDaemonCompiler({
        workDir: ctx.workspace.dir,
        supertexBin: SUPERTEX_BIN,
        readyTimeoutMs: 60_000,
        roundTimeoutMs: 120_000,
      }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws/project/${PROJECT_ID}`,
  );
  ws.binaryType = "arraybuffer";

  const frames = [];
  ws.on("message", (data) => {
    const buf = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data);
    frames.push(decodeFrame(buf));
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  try {
    // Wait for the first pdf-segment frame OR a compile-status error
    // (so a real failure surfaces immediately rather than waiting
    // out the whole deadline). 60s covers the lualatex cold-start
    // window comfortably.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (frames.some((f) => f.kind === "pdf-segment")) break;
      const err = frames.find(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "error",
      );
      if (err) {
        throw new Error(
          `compile-status:error before pdf-segment arrived: ${
            err.message.detail ?? "(no detail)"
          }`,
        );
      }
      await sleep(50);
    }

    const segFrame = frames.find((f) => f.kind === "pdf-segment");
    if (!segFrame) {
      const statuses = frames
        .filter(
          (f) => f.kind === "control" && f.message.type === "compile-status",
        )
        .map((f) => f.message.state)
        .join(",");
      throw new Error(
        `no pdf-segment within 60s; compile-status sequence: [${statuses}]`,
      );
    }

    const bytes = segFrame.segment.bytes;
    assert.ok(
      bytes.length > 1024,
      `pdf-segment implausibly small: ${bytes.length} bytes`,
    );
    const head = Buffer.from(bytes.slice(0, 4)).toString("utf8");
    assert.equal(
      head,
      "%PDF",
      `pdf-segment must start with %PDF, got ${JSON.stringify(head)}`,
    );

    const overlapErrors = frames.filter(
      (f) =>
        f.kind === "control" &&
        f.message.type === "compile-status" &&
        f.message.state === "error",
    );
    if (overlapErrors.length > 0) {
      const details = overlapErrors
        .map((f, i) => `  #${i + 1}: ${f.message.detail ?? "(no detail)"}`)
        .join("\n");
      throw new Error(
        `unexpected compile-status:error frame(s):\n${details}`,
      );
    }
  } finally {
    try {
      ws.close();
      await new Promise((r) => ws.once("close", r));
    } catch {
      /* ignore */
    }
    await app.close();
  }

  console.log("sidecarWorkspaceMirrorCompile.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
