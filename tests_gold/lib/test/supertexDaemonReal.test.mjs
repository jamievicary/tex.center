// Gold case for `SupertexDaemonCompiler` driving the real
// `vendor/supertex/build/supertex --daemon DIR` ELF (M7.5.5).
//
// Skips when the supertex binary or system `lualatex` are absent
// (e.g. fresh checkout where the supertex submodule has not been
// built, or a host without TeX Live). The build is owned by the
// supertex repo / sidecar Dockerfile, not by autodev iterations.
//
// What we assert: against a 2-page `.tex` fixture the compiler
// returns ok with a single segment whose bytes start with `%PDF`,
// and the persistent process survives a second compile call. This
// is the end-to-end coverage gating the `SIDECAR_COMPILER=
// supertex-daemon` default flip.

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
  console.log(`supertexDaemonReal.test.mjs: SKIP — ${msg}`);
  process.exit(0);
}

if (!existsSync(SUPERTEX_BIN)) {
  skip(`${SUPERTEX_BIN} not built (run vendor/supertex make)`);
}
const which = spawnSync("which", ["lualatex"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  skip("lualatex not on PATH (install TeX Live)");
}

// Dynamic import after the skip-gates so a fresh checkout without
// the sidecar dependencies installed still completes (with SKIP).
const { SupertexDaemonCompiler } = await import(
  resolve(ROOT, "apps/sidecar/src/compiler/supertexDaemon.ts")
);

const FIXTURE = `\\documentclass{article}
\\begin{document}
Hello, gold test.
\\newpage
Second page.
\\end{document}
`;

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-daemon-real-"));
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), FIXTURE);

  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 120_000,
  });

  try {
    const r1 = await c.compile({ source: FIXTURE, targetPage: 0 });
    if (!r1.ok) throw new Error(`first compile failed: ${r1.error}`);
    assert.equal(r1.segments.length, 1, "exactly one segment");
    const seg = r1.segments[0];
    assert.equal(seg.offset, 0);
    assert.equal(seg.totalLength, seg.bytes.length);
    const head = Buffer.from(seg.bytes.slice(0, 4)).toString("utf8");
    assert.equal(head, "%PDF", `segment must start with %PDF, got ${JSON.stringify(head)}`);
    assert.ok(
      seg.bytes.length > 1024,
      `segment implausibly small: ${seg.bytes.length} bytes`,
    );

    // Persistent process: second compile reuses the running daemon
    // and returns the same shape.
    const r2 = await c.compile({ source: FIXTURE, targetPage: 0 });
    if (!r2.ok) throw new Error(`second compile failed: ${r2.error}`);
    assert.equal(r2.segments.length, 1);
    assert.equal(
      Buffer.from(r2.segments[0].bytes.slice(0, 4)).toString("utf8"),
      "%PDF",
    );
  } finally {
    await c.close();
  }

  console.log("supertexDaemonReal.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
