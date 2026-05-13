// Probe for the GT-7 daemon-crash hypothesis (M9.editor-ux.regress.gt7,
// see .autodev/PLAN.md and .autodev/logs/{215..217}.md).
//
// Iter 217 discovered that `supertex --daemon` emits `supertex: edit
// detected at …/main.tex:NN` lines on stderr — i.e. it watches the
// source file in addition to processing stdin `recompile` commands.
// The iter-215 "stdin-driven only" claim is therefore wrong, and the
// iter-213-era write/recompile race hypothesis is back on the table:
// the sidecar's `writeMain(source)` may trip the daemon's
// file-watcher *before* (or interleaved with) the subsequent
// `recompile,T\n`, re-entering an in-flight round.
//
// This probe is independent of the browser path and bypasses
// `SupertexDaemonCompiler` (which always brackets writes with stdin
// commands, and rejects re-entrant compiles via the `busy` guard).
// We spawn `supertex --daemon DIR main.tex` directly so we can
// (a) write the source rapidly with no intervening stdin commands,
// (b) immediately follow a write with a `recompile,…\n` and observe
// whether the next round survives.
//
// Pass = daemon survives both probes and a final liveness round
// completes normally. Fail = daemon dies (process exit, SIGABRT,
// protocol violation, hang past round timeout) — which would be a
// concrete reproducer for GT-7.
//
// Skips when the supertex binary or system `lualatex` are absent.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SUPERTEX_BIN = resolve(ROOT, "vendor/supertex/build/supertex");

function skip(msg) {
  console.log(`supertexFilewatcherRace.test.mjs: SKIP — ${msg}`);
  process.exit(0);
}

if (!existsSync(SUPERTEX_BIN)) {
  skip(`${SUPERTEX_BIN} not built (run vendor/supertex make)`);
}
const which = spawnSync("which", ["lualatex"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  skip("lualatex not on PATH (install TeX Live)");
}

const READY_TIMEOUT_MS = 60_000;
const ROUND_TIMEOUT_MS = 120_000;

function makeFixture(tag) {
  return `\\documentclass{article}
\\begin{document}
Page one. Tag: ${tag}.
\\newpage
Page two.
\\end{document}
`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Daemon {
  constructor(workDir, chunksDir) {
    this.workDir = workDir;
    this.chunksDir = chunksDir;
    this.child = null;
    this.exited = null;
    this.stderr = "";
    this.stdoutBuf = "";
    this.lineWaiter = null;
    this.lineQueue = [];
    this.stdoutEnded = false;
  }

  async spawn() {
    await mkdir(this.chunksDir, { recursive: true });
    const child = spawn(
      SUPERTEX_BIN,
      ["--daemon", this.chunksDir, join(this.workDir, "main.tex")],
      { cwd: this.workDir, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      const w = this.lineWaiter;
      this.lineWaiter = null;
      if (w) w(null);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      process.stderr.write(`[daemon stderr] ${chunk}`);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdoutBuf += chunk;
      let nl;
      while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        process.stderr.write(`[daemon stdout] ${line}\n`);
        if (this.lineWaiter) {
          const w = this.lineWaiter;
          this.lineWaiter = null;
          w(line);
        } else {
          this.lineQueue.push(line);
        }
      }
    });
    child.stdout.on("end", () => {
      this.stdoutEnded = true;
      const w = this.lineWaiter;
      this.lineWaiter = null;
      if (w) w(null);
    });
    await this.waitReady();
  }

  async waitReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(
          `daemon exited before ready: code=${this.exited.code} signal=${this.exited.signal}\n${this.stderr}`,
        );
      }
      if (/^supertex: daemon ready$/m.test(this.stderr)) return;
      await sleep(50);
    }
    throw new Error(`daemon ready marker not seen within ${READY_TIMEOUT_MS}ms\n${this.stderr}`);
  }

  nextLine(timeoutMs) {
    if (this.lineQueue.length > 0) return Promise.resolve(this.lineQueue.shift());
    if (this.exited || this.stdoutEnded) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.lineWaiter = null;
        resolve("__timeout__");
      }, timeoutMs);
      this.lineWaiter = (line) => {
        clearTimeout(t);
        resolve(line);
      };
    });
  }

  writeStdin(text) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("daemon stdin not writable");
    }
    this.child.stdin.write(text);
  }

  async awaitRoundDone() {
    const deadline = Date.now() + ROUND_TIMEOUT_MS;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("round timed out");
      const line = await this.nextLine(remaining);
      if (line === null) {
        throw new Error(
          `daemon stream ended mid-round (exited=${JSON.stringify(this.exited)})\n${this.stderr}`,
        );
      }
      if (line === "__timeout__") throw new Error("round timed out");
      if (line === "[round-done]") return;
      // Tolerate [N.out], [rollback K], [error …] within a round.
      if (
        !/^\[\d+\.out\]$/.test(line) &&
        !/^\[rollback \d+\]$/.test(line) &&
        !/^\[error [^\]]*\]$/.test(line)
      ) {
        throw new Error(`protocol violation: ${line}`);
      }
    }
  }

  isAlive() {
    return !this.exited;
  }

  hasCrashStderr() {
    return (
      /assert(ion)?/i.test(this.stderr) ||
      /SIGABRT/i.test(this.stderr) ||
      /Abort(ed)?/i.test(this.stderr) ||
      /segmentation fault/i.test(this.stderr)
    );
  }

  async close() {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.end();
    } catch {}
    const t = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }, 3000);
    await new Promise((resolve) => this.child.once("exit", resolve));
    clearTimeout(t);
  }
}

async function probe1_pureWatcherReentry() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-fwrace1-"));
  await writeFile(join(workDir, "main.tex"), makeFixture("init"));
  const d = new Daemon(workDir, join(workDir, "chunks"));
  try {
    await d.spawn();

    // Baseline round so the daemon has done a full compile and is
    // sitting idle waiting for the next stdin command.
    d.writeStdin("recompile,1\n");
    await d.awaitRoundDone();

    // Rapidly rewrite main.tex with no intervening stdin commands.
    // Brief async yields between writes so the OS file-watcher has a
    // chance to fire — but we never send `recompile,…`.
    for (let i = 0; i < 10; i++) {
      await writeFile(join(workDir, "main.tex"), makeFixture(`w${i}`));
      await sleep(20);
      if (!d.isAlive()) {
        throw new Error(
          `daemon died during pure-watcher writes (i=${i}): exited=${JSON.stringify(d.exited)}\n${d.stderr}`,
        );
      }
    }

    // Liveness: a final stdin recompile must still complete. Allow
    // a generous extra round in case the watcher queued work that
    // happens to run first.
    d.writeStdin("recompile,1\n");
    await d.awaitRoundDone();

    if (d.hasCrashStderr()) {
      throw new Error(`crash signature in stderr after probe 1:\n${d.stderr}`);
    }
  } finally {
    await d.close();
  }
}

async function probe2_writeThenRecompileRace() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-fwrace2-"));
  await writeFile(join(workDir, "main.tex"), makeFixture("init"));
  const d = new Daemon(workDir, join(workDir, "chunks"));
  try {
    await d.spawn();
    d.writeStdin("recompile,1\n");
    await d.awaitRoundDone();

    // 10 iterations: write source, then *immediately* push a
    // recompile on stdin (no await). The file-watcher may have
    // already scheduled a round by the time the stdin command
    // arrives.
    for (let i = 0; i < 10; i++) {
      // Use a tight micro-pattern: synchronous write via the same
      // event tick as the stdin push to maximize the race window.
      await writeFile(join(workDir, "main.tex"), makeFixture(`r${i}`));
      d.writeStdin("recompile,1\n");
      await d.awaitRoundDone();
      if (!d.isAlive()) {
        throw new Error(
          `daemon died after race iteration ${i}: exited=${JSON.stringify(d.exited)}\n${d.stderr}`,
        );
      }
    }

    if (d.hasCrashStderr()) {
      throw new Error(`crash signature in stderr after probe 2:\n${d.stderr}`);
    }
  } finally {
    await d.close();
  }
}

async function main() {
  await probe1_pureWatcherReentry();
  await probe2_writeThenRecompileRace();
  console.log("supertexFilewatcherRace.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
