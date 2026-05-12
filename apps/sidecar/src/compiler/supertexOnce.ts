// `Compiler` that drives `vendor/supertex` once per request.
//
// Each `compile()` spawns:
//   <supertexBin> <workDir>/<sourceName> --once \
//     --output-directory <workDir>/out
//
// then reads the resulting PDF off disk and returns it as a single
// segment. Slow (full rebuild every edit) but end-to-end real, and
// the current production path until an upstream `--daemon DIR`
// mode lands.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Compiler, CompileRequest, CompileResult } from "./types.js";
import { defaultSpawnFn, supertexPaths, type SpawnFn } from "./supertexShared.js";

export interface SupertexOnceOptions {
  /** Project workspace dir; the source must already live here. */
  workDir: string;
  /** Path to a `supertex` executable understood by the M3 plan. */
  supertexBin: string;
  /** Source filename relative to `workDir`. Default `main.tex`. */
  sourceName?: string;
  /** Wallclock cap for one compile. Default 60 s. */
  timeoutMs?: number;
  /** Override `child_process.spawn` (used by tests). */
  spawnFn?: SpawnFn;
}

export class SupertexOnceCompiler implements Compiler {
  private readonly workDir: string;
  private readonly supertexBin: string;
  private readonly sourceName: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;

  constructor(opts: SupertexOnceOptions) {
    this.workDir = opts.workDir;
    this.supertexBin = opts.supertexBin;
    this.sourceName = opts.sourceName ?? "main.tex";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.spawnFn = opts.spawnFn ?? defaultSpawnFn;
  }

  async compile(_req: CompileRequest): Promise<CompileResult> {
    const { outDir, pdfPath } = supertexPaths(this.workDir, this.sourceName);
    await mkdir(outDir, { recursive: true });
    const sourcePath = join(this.workDir, this.sourceName);
    const args = [sourcePath, "--once", "--output-directory", outDir];

    let result: { code: number; stderr: string };
    try {
      result = await this.runOnce(args);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || "(no stderr)";
      return { ok: false, error: `supertex exited ${result.code}: ${detail}` };
    }
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
    return {
      ok: true,
      segments: [{ totalLength: bytes.length, offset: 0, bytes }],
    };
  }

  async close(): Promise<void> {}

  // Checkpoints are meaningless for the once-compiler: every
  // compile is a clean spawn that rebuilds from the on-disk
  // source. The no-op impls satisfy the interface so the sidecar
  // can call snapshot/restore uniformly regardless of the
  // configured engine.
  async snapshot(): Promise<Uint8Array | null> {
    return null;
  }

  async restore(_blob: Uint8Array): Promise<void> {}

  private runOnce(args: string[]): Promise<{ code: number; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = this.spawnFn(this.supertexBin, args, {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const settle = (v: { code: number; stderr: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(v);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdout?.on("data", () => {
        /* drain */
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({
          code: 124,
          stderr: stderr + `\n[supertex-once: timed out after ${this.timeoutMs}ms]`,
        });
      }, this.timeoutMs);
      child.on("error", fail);
      child.on("close", (code) => settle({ code: code ?? -1, stderr }));
    });
  }
}
