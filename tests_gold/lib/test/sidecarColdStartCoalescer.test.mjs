// Sidecar-level invariant lock for the M9.editor-ux.regress.gt7
// root cause identified in iter 221 (see
// `.autodev/discussion/220_answer.md`): the live deploy showed six
// `compile-status state:"error" detail:"…another compile already in
// flight"` control frames being broadcast to the client during the
// cold-start window of a single project. The mechanism is the
// per-project `CompileCoalescer` failing to hold off overlapping
// `runCompile()` invocations while the first compile is in flight.
//
// This test drives the full sidecar with the real
// `SupertexDaemonCompiler` and the real `vendor/supertex/build/supertex`
// binary across a cold-start window plus a rapid doc-update burst,
// and asserts that **no** `compile-status state:"error"` frame
// carrying `already in flight` reaches the client. The existing
// `serverCompileCoalescer.test.mjs` case 1 verifies the gate with a
// `ManualCompiler` mock; this test extends the assertion to the
// real-daemon path.
//
// Note (iter 222): on a local host the native daemon cold-start is
// fast enough (~300–500 ms) that the test does not currently
// reproduce the production failure mode even under aggressive
// kick load — the coalescer's inFlight gate holds. The test
// nonetheless stands as a regression lock on the assertion shape:
// any future change that lets `compiler.compile()` overlap on the
// real-daemon path will fail this case. A `COALESCER_SLOW_FIRST_MS`
// env var widens the first-compile window for stress runs.
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
  console.log(`sidecarColdStartCoalescer.test.mjs: SKIP — ${msg}`);
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
// the sidecar dependencies installed still completes (with SKIP).
const { SupertexDaemonCompiler } = await import(
  resolve(ROOT, "apps/sidecar/src/compiler/supertexDaemon.ts")
);
const { buildServer } = await import(
  resolve(ROOT, "apps/sidecar/src/server.ts")
);
const { encodeDocUpdate, MAIN_DOC_NAME, decodeFrame } = await import(
  resolve(ROOT, "packages/protocol/src/index.ts")
);
const Y = await import("yjs");
const { WebSocket } = await import("ws");

const PROJECT_ID = "00000000-0000-0000-0000-000000000777";

// Optional forced delay on the FIRST `compile()` call, simulating
// the slow lualatex cold-start observed on Fly Machines (~4 s). Off
// by default (test exercises native cold-start, ~300-500 ms locally);
// set `COALESCER_SLOW_FIRST_MS` to a positive number to widen the
// cold-start window for stress runs.
const SLOW_FIRST_MS = Number(process.env.COALESCER_SLOW_FIRST_MS ?? "0");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class SlowFirstCompileCompiler {
  constructor(inner, delayMs) {
    this.inner = inner;
    this.delayMs = delayMs;
    this.firstCompileDone = false;
  }
  async compile(req) {
    if (!this.firstCompileDone && this.delayMs > 0) {
      this.firstCompileDone = true;
      await sleep(this.delayMs);
    } else {
      this.firstCompileDone = true;
    }
    return this.inner.compile(req);
  }
  async close() { return this.inner.close(); }
  async warmup() { return this.inner.warmup(); }
  async snapshot() { return this.inner.snapshot(); }
  async restore(b) { return this.inner.restore(b); }
}

async function main() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-coalescer-"));
  const app = await buildServer({
    logger: process.env.COALESCER_TEST_LOG === "1" ? true : false,
    scratchRoot,
    compilerFactory: (ctx) => {
      const inner = new SupertexDaemonCompiler({
        workDir: ctx.workspace.dir,
        supertexBin: SUPERTEX_BIN,
        readyTimeoutMs: 60_000,
        roundTimeoutMs: 120_000,
      });
      return SLOW_FIRST_MS > 0
        ? new SlowFirstCompileCompiler(inner, SLOW_FIRST_MS)
        : inner;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws/project/${PROJECT_ID}`,
  );
  ws.binaryType = "arraybuffer";

  const frames = [];
  const clientDoc = new Y.Doc();
  const text = clientDoc.getText(MAIN_DOC_NAME);
  ws.on("message", (data) => {
    const buf =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const f = decodeFrame(buf);
    frames.push(f);
    if (f.kind === "doc-update") Y.applyUpdate(clientDoc, f.update);
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  try {
    // Wait for `compile-status state:"running"` — proof the first
    // compile has actually entered the daemon's cold-start window.
    {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (
          frames.some(
            (f) =>
              f.kind === "control" &&
              f.message.type === "compile-status" &&
              f.message.state === "running",
          )
        )
          break;
        await sleep(25);
      }
    }

    // Two-phase burst that straddles the slow first compile:
    //   - Phase A: 50 updates fired synchronously (zero spacing),
    //     matching the existing `ManualCompiler` unit-test burst.
    //   - Phase B: 30 updates spaced 100ms apart, matching live
    //     keystroke-cadence typing.
    // Both phases land during the forced-slow first compile window
    // so the coalescer's inFlight gate is under maximum pressure.
    for (let i = 0; i < 50; i++) {
      const before = Y.encodeStateVector(clientDoc);
      text.insert(text.length, ` a${i}`);
      ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc, before)));
    }
    for (let i = 0; i < 30; i++) {
      const before = Y.encodeStateVector(clientDoc);
      text.insert(text.length, ` b${i}`);
      ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(clientDoc, before)));
      await sleep(100);
    }

    // Drain: wait for an `idle` compile-status frame (the first
    // compile finished) plus at least one follow-up `idle` from the
    // queued compile. 60s is generous for the first cold-start
    // compile + a quick follow-up.
    {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const idleCount = frames.filter(
          (f) =>
            f.kind === "control" &&
            f.message.type === "compile-status" &&
            f.message.state === "idle",
        ).length;
        if (idleCount >= 1) break;
        await sleep(50);
      }
      await sleep(500); // a little extra drain time for trailing frames
    }

    const overlapErrors = frames.filter(
      (f) =>
        f.kind === "control" &&
        f.message.type === "compile-status" &&
        f.message.state === "error" &&
        /already in flight/i.test(f.message.detail ?? ""),
    );

    if (overlapErrors.length > 0) {
      const details = overlapErrors
        .map((f, i) => `  #${i + 1}: ${f.message.detail}`)
        .join("\n");
      throw new Error(
        `sidecar broadcast ${overlapErrors.length} ` +
          `"already in flight" compile-status:error frame(s) — the ` +
          `coalescer's inFlight gate failed to hold off overlapping ` +
          `runCompile() calls during the cold-start window:\n${details}`,
      );
    }
  } finally {
    try {
      ws.close();
      await new Promise((r) => ws.once("close", r));
    } catch {}
    await app.close();
  }

  console.log("sidecarColdStartCoalescer.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
