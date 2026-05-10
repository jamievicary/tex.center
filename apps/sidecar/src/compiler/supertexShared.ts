// Shared helpers for the supertex-backed compilers.
//
// `SpawnFn` is the test seam used by `featureDetect`,
// `SupertexOnceCompiler`, and `SupertexWatchCompiler`. Centralising
// it here keeps a single source of truth for the spawn signature.
//
// `supertexPaths` computes the conventional layout under a project
// workspace: `<workDir>/out/` for outputs, `shipouts` for the
// `--live-shipouts` log, and the PDF named after the source basename.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { basename, join } from "node:path";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export const defaultSpawnFn: SpawnFn = nodeSpawn as SpawnFn;

export interface SupertexPaths {
  outDir: string;
  shipoutsPath: string;
  pdfPath: string;
}

export function supertexPaths(workDir: string, sourceName: string): SupertexPaths {
  const outDir = join(workDir, "out");
  return {
    outDir,
    shipoutsPath: join(outDir, "shipouts"),
    pdfPath: join(outDir, basename(sourceName, ".tex") + ".pdf"),
  };
}
