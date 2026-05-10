// Shared helpers for the supertex-backed compiler(s).
//
// `SpawnFn` is the test seam used by `SupertexOnceCompiler`.
// Centralising it here keeps a single source of truth for the
// spawn signature in case additional compilers join later (the
// `--daemon DIR` consumer once that upstream mode lands).
//
// `supertexPaths` computes the conventional layout under a project
// workspace: `<workDir>/out/` for outputs and the PDF named after
// the source basename.

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
  pdfPath: string;
}

export function supertexPaths(workDir: string, sourceName: string): SupertexPaths {
  const outDir = join(workDir, "out");
  return {
    outDir,
    pdfPath: join(outDir, basename(sourceName, ".tex") + ".pdf"),
  };
}
