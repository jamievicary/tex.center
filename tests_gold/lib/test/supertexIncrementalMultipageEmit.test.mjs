// M15 — incremental multi-page emit pin (sidecar level).
//
// Live reproducer of `verifyLivePdfMultiPage` red gold case
// (iters 271–275): the live test types four `\newpage` breaks into a
// previously-seeded project, char-at-a-time with a 5 ms inter-key
// delay. The sidecar coalescer collapses the resulting 121
// TAG_DOC_UPDATE frames into ~11 compile rounds. Iter-275 diagnostic
// showed every one of those rounds returns `running` → `idle` with
// `result.segments.length === 0`, even though the equivalent
// SEED-then-write-MULTI flow in `supertexMultipageEmit.test.mjs`
// emits all 5 pages on the second compile.
//
// This test reproduces the live shape headlessly: SEED baseline, then
// 11 incremental coalesced writes carrying progressively more of
// MULTI to the workspace, each followed by `compile({ targetPage: 0 })`.
//
// PASS = the FINAL compile (with full MULTI on disk) emits a segment
// whose PDF carries ≥5 page refs. FAIL = the final compile is a
// silent no-op, or ships only page 1 — same observable as the live
// gold spec.
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
  console.log(`supertexIncrementalMultipageEmit.test.mjs: SKIP — ${msg}`);
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

const SEED = `\\documentclass{article}
\\begin{document}
Hello, world!
\\end{document}
`;

// Live spec inserts this fragment *just before* `\end{document}`,
// after pressing Enter on a line above. Mirror exactly.
const MULTIPAGE_BODY =
  "\\newpage Page two body text.\n" +
  "\\newpage Page three body text.\n" +
  "\\newpage Page four body text.\n" +
  "\\newpage Page five body text.\n";

function buildSource(insertedSoFar) {
  return `\\documentclass{article}
\\begin{document}
Hello, world!
${insertedSoFar}\\end{document}
`;
}

function pageRefCount(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  const m = text.match(/\/Type\s*\/Page[^s]/g);
  return m === null ? 0 : m.length;
}

const ROUNDS = 11;
const workDir = mkdtempSync(join(tmpdir(), "supertex-inc-mp-"));
await mkdir(workDir, { recursive: true });
await writeFile(join(workDir, "main.tex"), SEED);

const compiler = new SupertexDaemonCompiler({
  workDir,
  supertexBin: SUPERTEX_BIN,
  readyTimeoutMs: 60_000,
  roundTimeoutMs: 180_000,
});

const rounds = [];

try {
  // Baseline cold compile — matches the live "initial seeded
  // pdf-segment" landing before the user types anything.
  const baseline = await compiler.compile({ source: SEED, targetPage: 0 });
  assert.equal(
    baseline.ok,
    true,
    `baseline compile failed: ${!baseline.ok ? baseline.error : ""}`,
  );
  rounds.push({
    label: "baseline",
    segs: baseline.segments.length,
    pages: baseline.segments[0] ? pageRefCount(baseline.segments[0].bytes) : 0,
    bytes: baseline.segments[0]?.bytes.length ?? 0,
  });

  // Incremental writes: progressively grow `inserted` from "" to the
  // full MULTIPAGE_BODY in `ROUNDS` even chunks.
  for (let i = 1; i <= ROUNDS; i++) {
    const cutLen = Math.ceil((MULTIPAGE_BODY.length * i) / ROUNDS);
    const inserted = MULTIPAGE_BODY.slice(0, cutLen);
    const source = buildSource(inserted);
    await writeFile(join(workDir, "main.tex"), source);
    const r = await compiler.compile({ source, targetPage: 0 });
    if (!r.ok) {
      // Mid-typing partial LaTeX can be syntactically incomplete
      // (`\newpa…`); the daemon may surface a real error. Record but
      // don't abort — we care about the FINAL full-MULTI compile.
      rounds.push({
        label: `step-${i}`,
        error: r.error,
        sourceLen: source.length,
      });
      continue;
    }
    rounds.push({
      label: `step-${i}`,
      segs: r.segments.length,
      pages: r.segments[0] ? pageRefCount(r.segments[0].bytes) : 0,
      bytes: r.segments[0]?.bytes.length ?? 0,
      sourceLen: source.length,
    });
  }
} finally {
  try {
    await compiler.close();
  } catch {}
}

console.log("rounds:");
for (const r of rounds) {
  console.log(`  ${JSON.stringify(r)}`);
}

const final = rounds[rounds.length - 1];
const finalEmittedPages = final.pages ?? 0;
if (finalEmittedPages < 5) {
  console.error(
    `\nM15 INCREMENTAL BUG REPRODUCED — final compile emitted ` +
      `pages=${finalEmittedPages} (segs=${final.segs ?? 0}). ` +
      `Expected ≥5 page refs after writing full MULTIPAGE_BODY.`,
  );
  process.exit(1);
}

console.log(
  `supertexIncrementalMultipageEmit.test.mjs: PASS — final pages=${finalEmittedPages}`,
);
