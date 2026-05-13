// Fast local repro for GT-8 (M9.editor-ux.regress.gt7) — the upstream
// `supertex --daemon` SIGABRT (code 134, "protocol violation: child
// exited") triggered by the user's literal repro from
// `.autodev/discussion/220_question.md`:
//
//   1. Create a new project (cold sidecar).
//   2. Append `\newpage XX` just before `\end{document}`.
//   3. Repeat step 2 every ~500ms. After ~15 instances a red toast
//      appears.
//
// Iter 224 confirmed the bug live (see GT-8
// `verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts`); this file is
// the headless equivalent: spawn `supertex --daemon DIR main.tex`
// directly via `SupertexDaemonCompiler`, seed a "Hello, world!"
// document, and run 20 rounds that each (a) append one `\newpage NN`
// line just before `\end{document}` and (b) drive `recompile,T` with
// T = current page count.
//
// Why a local test in addition to GT-8: the Playwright spec needs a
// cold Fly Machine + cold-start window (~60-90s, with R2 sync and
// first-lualatex). Running it from the upstream side requires
// `creds/` and several minutes per attempt. This local repro spawns
// a fresh `supertex --daemon` (which is itself cold for its first
// compile), drives the same stdin pattern, and either reproduces the
// abort in under a minute or pins the fact that the bug requires
// some non-stdin trigger (R2 hydration, websocket churn, …).
//
// Pass = daemon survives every round and a final liveness round
// completes normally. Fail = `r.ok === false` with one of the
// `child exited` / `protocol violation` / `stdin not writable`
// signatures the live GT-8 spec also keys on.
//
// Skips when the supertex binary or system `lualatex` are absent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SUPERTEX_BIN = resolve(ROOT, "vendor/supertex/build/supertex");

function skip(msg) {
  console.log(`supertexColdNewpageCrash.test.mjs: SKIP — ${msg}`);
  process.exit(0);
}

if (!existsSync(SUPERTEX_BIN)) {
  skip(`${SUPERTEX_BIN} not built (run vendor/supertex make)`);
}
const which = spawnSync("which", ["lualatex"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  skip("lualatex not on PATH (install TeX Live)");
}

const { SupertexDaemonCompiler } = await import(
  resolve(ROOT, "apps/sidecar/src/compiler/supertexDaemon.ts")
);

const ROUNDS = 20;
// 500ms inter-round delay matches the user's repro cadence. Most
// rounds complete in well under 500ms once the daemon is warm; the
// pause models the user's per-keystroke timing, which is the only
// timing detail in 220_question.md.
const INTER_ROUND_DELAY_MS = 500;

const SEED = `\\documentclass{article}
\\begin{document}
Hello, world!
\\end{document}
`;

function withAppendedNewpages(n) {
  // Build the document with N appended `\newpage NN` lines just
  // before `\end{document}`. Each line adds a page.
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`\\newpage ${String(i).padStart(2, "0")}`);
  }
  return `\\documentclass{article}
\\begin{document}
Hello, world!
${lines.join("\n")}
\\end{document}
`;
}

function isCrashError(msg) {
  return (
    /protocol violation/i.test(msg) ||
    /child exited/i.test(msg) ||
    /stdin not writable/i.test(msg)
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-cold-newpage-"));
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), SEED);

  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 180_000,
  });

  let lastRound = -1;
  try {
    // Baseline compile of the seed document. This is the daemon's
    // first lualatex round — the closest local analogue to the live
    // "cold start" the user hits. Target page = 1.
    const baseline = await c.compile({ source: SEED, targetPage: 1 });
    if (!baseline.ok) {
      if (isCrashError(baseline.error ?? "")) {
        throw new Error(
          `supertex daemon died on baseline (cold) compile: ${baseline.error}`,
        );
      }
      throw new Error(`baseline compile failed: ${baseline.error}`);
    }
    assert.equal(baseline.segments.length, 1);

    // 20 rounds of "append one `\newpage NN` line, recompile". This
    // is the user's exact stdin-side sequence — modulo cold-start
    // overlap, which a single in-process daemon cannot reproduce
    // (the busy-guard serialises rounds the way the live sidecar
    // coalescer does).
    for (let i = 0; i < ROUNDS; i++) {
      lastRound = i;
      const source = withAppendedNewpages(i + 1);
      // Mirror the sidecar's runCompile: write main.tex, then drive
      // the daemon. (SupertexDaemonCompiler.compile does not write
      // the file itself.)
      await writeFile(join(workDir, "main.tex"), source);
      // Target page = i + 2 (initial page + i+1 appended `\newpage`
      // pages). Matches what the sidecar would send if the user
      // scrolled to the last page each time, which is the realistic
      // viewer cadence as more pages appear.
      const target = i + 2;
      const r = await c.compile({ source, targetPage: target });
      if (!r.ok) {
        if (isCrashError(r.error ?? "")) {
          throw new Error(
            `supertex daemon crashed on round ${i} ` +
              `(target=${target}, doc=${i + 1} appended \\newpage lines): ${r.error}`,
          );
        }
        // Non-crash compile errors (well-formed upstream `[error …]`)
        // are unexpected for this fixture but do not by themselves
        // prove the GT-8 bug; surface them and continue so we see
        // the full transcript.
        console.error(
          `[supertexColdNewpageCrash] round ${i} ok=false (non-crash): ${r.error}`,
        );
      }
      if (i + 1 < ROUNDS) await sleep(INTER_ROUND_DELAY_MS);
    }

    // Liveness round: one more recompile to confirm the daemon is
    // still serving stdin. Forces a tiny source edit so we don't
    // hit the no-op rollback path.
    const finalSource = withAppendedNewpages(ROUNDS).replace(
      "Hello, world!",
      "Hello, world (final).",
    );
    await writeFile(join(workDir, "main.tex"), finalSource);
    const final = await c.compile({ source: finalSource, targetPage: 1 });
    if (!final.ok) {
      if (isCrashError(final.error ?? "")) {
        throw new Error(
          `supertex daemon crashed on liveness round after ${ROUNDS} ` +
            `newpage rounds: ${final.error}`,
        );
      }
      throw new Error(`liveness compile failed: ${final.error}`);
    }
  } finally {
    try {
      await c.close();
    } catch {}
  }

  // Probe 2 — "coalesced big-paste" pattern. The live sidecar's
  // coalescer collapses every edit that arrives while a compile is
  // running into a single pending source. On a cold start (first
  // lualatex round = 60-90s), the user types ~15 `\newpage` lines
  // during round 1; the coalescer turns those into a single +15-line
  // delta for round 2. This probe simulates that: baseline compile
  // (cold), then a SINGLE round with 15 newpages added at once,
  // then 5 small follow-up rounds.
  const workDir2 = mkdtempSync(join(tmpdir(), "supertex-cold-bigpaste-"));
  await mkdir(workDir2, { recursive: true });
  await writeFile(join(workDir2, "main.tex"), SEED);
  const c2 = new SupertexDaemonCompiler({
    workDir: workDir2,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 180_000,
  });
  try {
    const baseline2 = await c2.compile({ source: SEED, targetPage: 1 });
    if (!baseline2.ok) {
      if (isCrashError(baseline2.error ?? "")) {
        throw new Error(
          `[probe2] supertex daemon died on baseline: ${baseline2.error}`,
        );
      }
      throw new Error(`[probe2] baseline failed: ${baseline2.error}`);
    }

    // Big-paste round: 15 newpages appended in one delta.
    const BIG_N = 15;
    const bigSource = withAppendedNewpages(BIG_N);
    await writeFile(join(workDir2, "main.tex"), bigSource);
    const big = await c2.compile({ source: bigSource, targetPage: BIG_N + 1 });
    if (!big.ok && isCrashError(big.error ?? "")) {
      throw new Error(
        `[probe2] supertex daemon crashed on big-paste round ` +
          `(+${BIG_N} \\newpage lines at once): ${big.error}`,
      );
    }

    // 5 follow-up rounds, each adding one more newpage.
    for (let i = 0; i < 5; i++) {
      const n = BIG_N + 1 + i;
      const src = withAppendedNewpages(n);
      await writeFile(join(workDir2, "main.tex"), src);
      const r = await c2.compile({ source: src, targetPage: n + 1 });
      if (!r.ok && isCrashError(r.error ?? "")) {
        throw new Error(
          `[probe2] supertex daemon crashed on follow-up round ${i} ` +
            `(doc=${n} \\newpage lines): ${r.error}`,
        );
      }
      await sleep(INTER_ROUND_DELAY_MS);
    }
  } finally {
    try {
      await c2.close();
    } catch {}
  }

  console.log(
    `supertexColdNewpageCrash.test.mjs: PASS (lastRound=${lastRound})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
