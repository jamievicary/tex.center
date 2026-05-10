// Detects which optional CLI flags the configured `supertex` binary
// supports. Run once at sidecar startup so per-compile spawns can
// conditionally pass flags that older builds don't recognise.
//
// Today we look for two flags both tracked by PLAN.md M3.5:
//   - `--ready-marker <STRING>` — end-of-compile-round stdout
//     signal used by `SupertexWatchCompiler`.
//   - `--target-page=N` — stop-after-page mode used to honour
//     GOAL.md's "compile only as far as the visible page".
//
// Detection runs `<bin> --help` and greps the combined output. Both
// stdout and stderr are inspected because help output can land on
// either depending on the binary's argparse style.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SupertexFeatures {
  readyMarker: boolean;
  targetPage: boolean;
}

export interface DetectOptions {
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const NONE: SupertexFeatures = { readyMarker: false, targetPage: false };

export async function detectSupertexFeatures(
  supertexBin: string,
  opts: DetectOptions = {},
): Promise<SupertexFeatures> {
  const spawnFn = opts.spawnFn ?? (nodeSpawn as SpawnFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawnFn(supertexBin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return NONE;
  }

  return await new Promise<SupertexFeatures>((resolve) => {
    let out = "";
    let settled = false;
    const finish = (features: SupertexFeatures): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(features);
    };
    const timer = setTimeout(() => finish(NONE), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(NONE));
    child.on("close", () => {
      finish({
        readyMarker: /--ready-marker\b/.test(out),
        targetPage: /--target-page\b/.test(out),
      });
    });
  });
}
