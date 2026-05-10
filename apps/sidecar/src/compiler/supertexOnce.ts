// `Compiler` that drives `vendor/supertex` once per request.
//
// Each `compile()` spawns:
//   <supertexBin> <workDir>/<sourceName> --once \
//     --output-directory <workDir>/out \
//     --live-shipouts <workDir>/out/shipouts
//
// then reads the resulting PDF off disk and returns it as a single
// segment. Slow (full rebuild every edit) but end-to-end real.
// M3.2 of the plan: parity with the fixture path on the wire while
// the input is plumbed through to a real engine. M3.3 replaces this
// with a long-lived watch process; M3.4 chunks the PDF using the
// shipouts log; M3.5 wires `--target-page=N`.
//
// The caller (the sidecar's compile loop) is responsible for having
// written the source to `<workDir>/<sourceName>` *before* calling
// `compile()` — `ProjectWorkspace.writeMain` does that today.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Compiler, CompileRequest, CompileResult } from "./types.js";
import type { SupertexFeatures } from "./featureDetect.js";
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
  /** Capabilities advertised by the supertex binary. */
  features?: SupertexFeatures;
  /** Override `child_process.spawn` (used by tests). */
  spawnFn?: SpawnFn;
}

export class SupertexOnceCompiler implements Compiler {
  private readonly workDir: string;
  private readonly supertexBin: string;
  private readonly sourceName: string;
  private readonly timeoutMs: number;
  private readonly features: SupertexFeatures;
  private readonly spawnFn: SpawnFn;

  constructor(opts: SupertexOnceOptions) {
    this.workDir = opts.workDir;
    this.supertexBin = opts.supertexBin;
    this.sourceName = opts.sourceName ?? "main.tex";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.features = opts.features ?? { readyMarker: false, targetPage: false };
    this.spawnFn = opts.spawnFn ?? defaultSpawnFn;
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    const { outDir, shipoutsPath, pdfPath } = supertexPaths(this.workDir, this.sourceName);
    await mkdir(outDir, { recursive: true });
    const sourcePath = join(this.workDir, this.sourceName);
    const args = [
      sourcePath,
      "--once",
      "--output-directory",
      outDir,
      "--live-shipouts",
      shipoutsPath,
    ];
    if (this.features.targetPage && req.targetPage > 0) {
      args.push(`--target-page=${req.targetPage}`);
    }

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
