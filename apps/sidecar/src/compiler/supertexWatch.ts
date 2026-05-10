// `Compiler` that drives one long-lived `vendor/supertex` watch
// process per project. The sidecar's caller writes `main.tex` to
// the project workspace before each `compile()` invocation;
// supertex's own inotify watcher detects the change and
// recompiles. We synchronise on a single stdout line — the READY
// marker — emitted by supertex at the end of each watch-loop
// compile round.
//
// The READY-marker contract is currently only honoured by the
// fake binary used in `apps/sidecar/test/supertexWatchCompiler.test.mjs`.
// Real `vendor/supertex` does not emit it yet; PLAN.md M3.5 tracks
// the upstream PR to add the flag (proposed shape:
// `--ready-marker <STRING>` on the watch CLI). Until that PR lands,
// `SIDECAR_COMPILER=supertex-watch` is unusable against the real
// engine — the sidecar half is in tree to validate lifecycle,
// reaping, and the writeMain → compile() flow.
//
// The end-of-round marker, not a quiet-period heuristic, is what
// makes this compiler deterministic. Polling the shipouts file
// for "no new lines for N ms" fails the anti-flake rule.
//
// Lifecycle:
//   - First `compile()` lazily spawns the watch process, then
//     awaits the initial-compile READY.
//   - Subsequent `compile()` calls await the next READY (the
//     sidecar's caller has already overwritten `main.tex`).
//   - `close()` SIGTERMs the child, awaits exit, escalates to
//     SIGKILL after 2 s. The child must be gone after `close()`
//     returns (paired pgrep-style test in the suite).

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Compiler, CompileRequest, CompileResult } from "./types.js";
import { ShipoutSegmenter } from "./pdfSegmenter.js";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const DEFAULT_READY_MARKER = "SUPERTEX_READY";
const DEFAULT_COMPILE_TIMEOUT_MS = 60_000;
const TERM_GRACE_MS = 2_000;

export interface SupertexWatchOptions {
  workDir: string;
  supertexBin: string;
  /** Source filename relative to `workDir`. Default `main.tex`. */
  sourceName?: string;
  /** Stdout line that signals end-of-compile-round. */
  readyMarker?: string;
  /** Per-`compile()` wallclock cap. Default 60 s. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before SIGKILL on `close()`. */
  termGraceMs?: number;
  /** Extra args to append after the standard set. */
  extraArgs?: readonly string[];
  spawnFn?: SpawnFn;
}

export class SupertexWatchCompiler implements Compiler {
  private readonly workDir: string;
  private readonly supertexBin: string;
  private readonly sourceName: string;
  private readonly readyMarker: string;
  private readonly timeoutMs: number;
  private readonly termGraceMs: number;
  private readonly extraArgs: readonly string[];
  private readonly spawnFn: SpawnFn;

  private segmenter: ShipoutSegmenter | null = null;
  private child: ChildProcess | null = null;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitWaiters: Array<() => void> = [];
  private stderrBuf = "";
  private stdoutLineBuf = "";
  private pendingReady = 0;
  private currentReadyResolver: (() => void) | null = null;
  private closed = false;

  constructor(opts: SupertexWatchOptions) {
    this.workDir = opts.workDir;
    this.supertexBin = opts.supertexBin;
    this.sourceName = opts.sourceName ?? "main.tex";
    this.readyMarker = opts.readyMarker ?? DEFAULT_READY_MARKER;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
    this.termGraceMs = opts.termGraceMs ?? TERM_GRACE_MS;
    this.extraArgs = opts.extraArgs ?? [];
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as SpawnFn);
  }

  /** PID of the watch process, or `null` if not yet spawned / already reaped. */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  async compile(_req: CompileRequest): Promise<CompileResult> {
    if (this.closed) return { ok: false, error: "supertex watch: compiler closed" };
    const outDir = join(this.workDir, "out");
    await mkdir(outDir, { recursive: true });

    if (!this.child) {
      try {
        await this.spawnWatcher();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    const waitOutcome = await this.awaitReadyOrExit();
    if (waitOutcome.kind === "timeout") {
      return {
        ok: false,
        error:
          `supertex watch: timed out after ${this.timeoutMs}ms waiting for "${this.readyMarker}"\n` +
          (this.stderrBuf.trim() || "(no stderr)"),
      };
    }
    if (waitOutcome.kind === "exit") {
      return {
        ok: false,
        error:
          `supertex watch exited unexpectedly (code=${waitOutcome.code} signal=${waitOutcome.signal})\n` +
          (this.stderrBuf.trim() || "(no stderr)"),
      };
    }

    const pdfPath = join(outDir, basename(this.sourceName, ".tex") + ".pdf");
    let bytes: Uint8Array;
    try {
      const buf = await readFile(pdfPath);
      bytes = new Uint8Array(buf);
    } catch (e) {
      return {
        ok: false,
        error: `pdf not produced at ${pdfPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!this.segmenter) {
      this.segmenter = new ShipoutSegmenter(join(outDir, "shipouts"));
    }
    const segments = await this.segmenter.update(bytes);
    return { ok: true, segments };
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    if (this.exited) {
      this.child = null;
      return;
    }
    child.kill("SIGTERM");
    let killed = false;
    const killTimer = setTimeout(() => {
      if (!this.exited) {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, this.termGraceMs);
    try {
      await new Promise<void>((resolve) => {
        if (this.exited) return resolve();
        this.exitWaiters.push(resolve);
      });
    } finally {
      clearTimeout(killTimer);
    }
    void killed; // surfaced via stderr buf; not asserted on here
    this.child = null;
  }

  private async spawnWatcher(): Promise<void> {
    const outDir = join(this.workDir, "out");
    const args = [
      join(this.workDir, this.sourceName),
      "--output-directory",
      outDir,
      "--live-shipouts",
      join(outDir, "shipouts"),
      ...this.extraArgs,
    ];
    const child = this.spawnFn(this.supertexBin, args, {
      cwd: this.workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 64 * 1024) {
        this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
      }
    });
    child.on("close", (code, signal) => {
      this.exited = { code, signal };
      // Unblock any compile() awaiting a marker — they'll observe
      // the exit via awaitReadyOrExit.
      const cur = this.currentReadyResolver;
      this.currentReadyResolver = null;
      if (cur) cur();
      const waiters = this.exitWaiters.splice(0);
      for (const w of waiters) w();
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(err);
      };
      const onSpawn = (): void => {
        child.removeListener("error", onErr);
        resolve();
      };
      child.once("error", onErr);
      child.once("spawn", onSpawn);
    });
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutLineBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutLineBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutLineBuf.slice(0, idx).replace(/\r$/, "");
      this.stdoutLineBuf = this.stdoutLineBuf.slice(idx + 1);
      if (line === this.readyMarker) {
        const r = this.currentReadyResolver;
        if (r) {
          this.currentReadyResolver = null;
          r();
        } else {
          this.pendingReady++;
        }
      }
    }
  }

  private awaitReadyOrExit(): Promise<
    | { kind: "ready" }
    | { kind: "timeout" }
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  > {
    if (this.exited) {
      return Promise.resolve({ kind: "exit", code: this.exited.code, signal: this.exited.signal });
    }
    if (this.pendingReady > 0) {
      this.pendingReady--;
      return Promise.resolve({ kind: "ready" });
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (
        v:
          | { kind: "ready" }
          | { kind: "timeout" }
          | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.currentReadyResolver = null;
        resolve(v);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), this.timeoutMs);
      this.currentReadyResolver = () => {
        if (this.exited) {
          settle({ kind: "exit", code: this.exited.code, signal: this.exited.signal });
        } else {
          settle({ kind: "ready" });
        }
      };
    });
  }
}
