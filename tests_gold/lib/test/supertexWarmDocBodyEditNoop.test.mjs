// Fast local repro for the GT-5 silent-no-op upstream bug
// (`.autodev/discussion/229_question.md`, iter-228 + iter-229
// findings). The shape: the `supertex --daemon` `recompile,T` round
// completes with `round-done` and zero `[N.out]` shipout events ⇒
// the sidecar's `SupertexDaemonCompiler.compile()` returns
// `{ok:true, segments:[], noopReason:"…no usable rollback target…"}`
// at `apps/sidecar/src/compiler/supertexDaemon.ts:141`.
//
// The live trigger is "warm doc with body text already typed past
// the seeded `Hello, world!` line, then a multi-line body edit
// (`\section{...}`) lands at an offset past every extant
// supertex checkpoint". GT-5 reproduces it on the shared live
// project after GT-D / GT-7 cumulative typing, but only ~once per
// gold pass on the live deploy.
//
// This test reproduces the sequence headlessly by driving
// `supertex --daemon` directly through `SupertexDaemonCompiler`,
// replaying the GT-5 keystroke pattern as a series of incremental
// recompiles on top of GT-D's typed body. PASS = every round either
// emits ≥1 shipout or surfaces an explicit error (i.e. no silent
// no-op rounds). FAIL = at least one round returns `ok:true` with
// `segments.length === 0` and a `noopReason` — the upstream bug.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SUPERTEX_BIN = resolve(ROOT, "vendor/supertex/build/supertex");

function skip(msg) {
  console.log(`supertexWarmDocBodyEditNoop.test.mjs: SKIP — ${msg}`);
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

const SEED =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Hello, world!\n" +
  "\\end{document}\n";

// GT-D's TYPING_BODY (verifyLiveGt4SustainedTyping.spec.ts:34).
const GT4_TYPING_BODY =
  "Coalescer probe " +
  "abcdefghijklmnopqrstuvwxyz " +
  "0123456789 " +
  "The quick brown fox jumps over the lazy dog. " +
  "Some more padding bytes to extend the typing window.";

// GT-5's edit payload (verifyLiveGt5EditUpdatesPreview.spec.ts:32).
const GT5_EDIT_PAYLOAD = "\n\\section{New Section}\n";

// Helper: build the document with `extraOnHelloLine` appended after
// "Hello, world!" on the same line, and `afterHelloLine` inserted
// as new lines between that line and `\end{document}`.
function buildDoc(extraOnHelloLine, afterHelloLine) {
  return (
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    "Hello, world!" +
    extraOnHelloLine +
    "\n" +
    afterHelloLine +
    "\\end{document}\n"
  );
}

// Coalescer-shaped chunks: split typing into a handful of growth
// steps rather than one keystroke per round (the live coalescer
// collapses multiple keystrokes per round at typing speed). We
// mirror the chunked-growth shape rather than per-character to keep
// the test fast — the bug surfaces from cumulative-state buildup,
// not per-keystroke pacing.
function chunkedGrowth(s, steps) {
  const len = s.length;
  const out = [];
  for (let i = 1; i <= steps; i++) {
    out.push(s.slice(0, Math.ceil((len * i) / steps)));
  }
  return out;
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-warm-noop-"));
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), SEED);

  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 180_000,
  });

  const noopRounds = [];

  function recordRound(label, source, result) {
    if (!result.ok) {
      throw new Error(
        `[${label}] supertex daemon error (sourceLen=${source.length}): ${result.error}`,
      );
    }
    if ((result.segments?.length ?? 0) === 0) {
      noopRounds.push({
        label,
        sourceLen: source.length,
        noopReason: result.noopReason ?? "(no noopReason set)",
        sourceTail: source.slice(-160),
      });
    }
  }

  try {
    // Baseline (cold) compile. Target page 1 (only one page).
    const baseline = await c.compile({ source: SEED, targetPage: 1 });
    recordRound("baseline", SEED, baseline);

    // Phase 1: GT-D typing — append `GT4_TYPING_BODY` to the
    // "Hello, world!" line in 8 coalesced growth steps. This builds
    // the polluted warm-doc state GT-5 then edits on top of.
    const gt4Steps = chunkedGrowth(GT4_TYPING_BODY, 8);
    for (let i = 0; i < gt4Steps.length; i++) {
      const source = buildDoc(gt4Steps[i], "");
      await writeFile(join(workDir, "main.tex"), source);
      const r = await c.compile({ source, targetPage: 1 });
      recordRound(`gt4-step-${i + 1}`, source, r);
    }

    // Phase 2: GT-5 edit — insert `\n\\section{New Section}\n`
    // between the "Hello, world!…" body line and `\end{document}`.
    // The live spec types this payload character-at-a-time with a
    // 5ms inter-key delay; we replay it as 3 coalesced sub-rounds
    // matching the natural delimiters in the payload (`\n`,
    // `\\section{New Section}`, `\n`).
    const fullExtra = GT4_TYPING_BODY;
    const gt5Subrounds = [
      "\n",
      "\n\\section{New Section}",
      "\n\\section{New Section}\n",
    ];
    for (let i = 0; i < gt5Subrounds.length; i++) {
      const source = buildDoc(fullExtra, gt5Subrounds[i]);
      await writeFile(join(workDir, "main.tex"), source);
      const r = await c.compile({ source, targetPage: 1 });
      recordRound(`gt5-sub-${i + 1}`, source, r);
    }
  } finally {
    try {
      await c.close();
    } catch {}
  }

  if (noopRounds.length > 0) {
    const lines = [
      "supertex daemon emitted silent no-op round(s) — UPSTREAM BUG REPRODUCED:",
      ...noopRounds.map(
        (n) =>
          `  [${n.label}] sourceLen=${n.sourceLen} noopReason=${JSON.stringify(n.noopReason)}\n` +
          `    sourceTail=${JSON.stringify(n.sourceTail)}`,
      ),
    ];
    console.error(lines.join("\n"));
    process.exit(1);
  }

  console.log(
    "supertexWarmDocBodyEditNoop.test.mjs: PASS — no silent no-op rounds",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
