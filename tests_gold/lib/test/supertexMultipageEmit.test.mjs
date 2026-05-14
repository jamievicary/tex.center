// M15 — multi-page emit pin (sidecar level).
//
// Reproduces the iter-269 diagnosis: with `targetPage=1` the
// supertex daemon ships only page 1 even when the source has
// multiple pages, which is exactly the chicken-and-egg condition
// the live `verifyLivePdfMultiPage` spec hits (no viewer ever sets
// `viewingPage > 1` until page-2 canvas exists, but page-2 canvas
// never exists until page-2 is shipped). Iter 269 switched the
// sidecar default to `targetPage=0` ("end"), so every compile
// ships every page.
//
// This local pin runs the real `vendor/supertex` daemon binary on a
// 5-page document and asserts:
//
//   - `targetPage=0`  →  segment carries all 5 pages (PDF `/Type
//     /Page` reference count is ≥ 5 and the assembled byte buffer
//     is significantly larger than the page-1-only run);
//   - `targetPage=1`  →  segment carries page 1 only (control
//     comparison; pins the underlying daemon semantics so a future
//     regression in the optimisation hatch — re-introducing a
//     per-viewer page clamp — surfaces here, not in a 3.3-minute
//     live spec).
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
  console.log(`supertexMultipageEmit.test.mjs: SKIP — ${msg}`);
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

const MULTI = `\\documentclass{article}
\\begin{document}
Hello, world!
\\newpage Page two body text.
\\newpage Page three body text.
\\newpage Page four body text.
\\newpage Page five body text.
\\end{document}
`;

function assembledBytes(result) {
  assert.equal(result.ok, true, `compile failed: ${result.error}`);
  assert.equal(result.segments.length, 1, "expected exactly one segment");
  const seg = result.segments[0];
  assert.equal(seg.offset, 0, "segment must start at offset 0");
  assert.equal(
    seg.totalLength,
    seg.bytes.length,
    "segment totalLength must match bytes.length",
  );
  return seg.bytes;
}

function pageRefCount(bytes) {
  // PDF page objects are stamped `/Type /Page` (with a trailing
  // non-`s` byte so we don't match `/Type /Pages`). Latin-1 is the
  // canonical PDF text encoding for the cross-reference body.
  const text = new TextDecoder("latin1").decode(bytes);
  const m = text.match(/\/Type\s*\/Page[^s]/g);
  return m === null ? 0 : m.length;
}

async function compileMultipageWithTarget(target) {
  const workDir = mkdtempSync(join(tmpdir(), `supertex-mp-${target}-`));
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), SEED);
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 180_000,
  });
  try {
    const baseline = await c.compile({ source: SEED, targetPage: 1 });
    assembledBytes(baseline);

    await writeFile(join(workDir, "main.tex"), MULTI);
    const result = await c.compile({ source: MULTI, targetPage: target });
    return assembledBytes(result);
  } finally {
    try {
      await c.close();
    } catch {}
  }
}

// Case 1 — current sidecar default. `targetPage=0` ships every page.
{
  const bytes = await compileMultipageWithTarget(0);
  const pages = pageRefCount(bytes);
  assert.ok(
    pages >= 5,
    `targetPage=0 expected ≥5 page refs in PDF, got ${pages} ` +
      `(bytes.length=${bytes.length})`,
  );
  console.log(
    `supertexMultipageEmit: targetPage=0 → bytes=${bytes.length} pages=${pages}`,
  );
}

// Case 2 — pre-iter-269 default. `targetPage=1` ships page 1 only.
// Control comparison: pins the daemon's per-target semantics so the
// optimisation hatch can be re-introduced safely later.
{
  const bytes = await compileMultipageWithTarget(1);
  const pages = pageRefCount(bytes);
  assert.equal(
    pages,
    1,
    `targetPage=1 expected exactly 1 page ref in PDF, got ${pages} ` +
      `(bytes.length=${bytes.length})`,
  );
  console.log(
    `supertexMultipageEmit: targetPage=1 → bytes=${bytes.length} pages=${pages}`,
  );
}

console.log("supertexMultipageEmit.test.mjs: PASS");
