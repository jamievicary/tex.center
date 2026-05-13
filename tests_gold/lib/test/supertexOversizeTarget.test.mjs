// Probe for the GT-7 daemon-crash hypothesis (M9.editor-ux.regress.gt7,
// see .autodev/PLAN.md and .autodev/logs/216.md).
//
// Strongest current theory: the sidecar sends `recompile,T\n` where T
// is `maxViewingPage`, which can exceed the document's actual page
// count (e.g. after a paste/edit shrinks the doc, or simply because a
// fresh viewer has not yet sent a viewing-page update). Upstream
// `supertex --daemon` may assert / abort on T > page_count.
//
// This probe is independent of the browser path: it drives a real
// `supertex --daemon DIR` ELF directly via `SupertexDaemonCompiler`
// against a 2-page fixture, then issues `recompile` rounds with T
// successively far beyond the page count.
//
// Pass = daemon survives every oversize round (returns ok or a
// well-formed error reason). Fail = daemon dies with a protocol
// violation / child-exited frame, which is exactly the GT-7
// signature.
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
  console.log(`supertexOversizeTarget.test.mjs: SKIP — ${msg}`);
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

const FIXTURE = `\\documentclass{article}
\\begin{document}
Page one.
\\newpage
Page two.
\\end{document}
`;

const OVERSIZE_TARGETS = [3, 5, 10, 100];

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "supertex-oversize-"));
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), FIXTURE);

  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: SUPERTEX_BIN,
    readyTimeoutMs: 60_000,
    roundTimeoutMs: 120_000,
  });

  try {
    // Baseline: in-range target. Must succeed, daemon must come up.
    const baseline = await c.compile({ source: FIXTURE, targetPage: 1 });
    if (!baseline.ok) {
      throw new Error(`baseline compile failed: ${baseline.error}`);
    }
    assert.equal(baseline.segments.length, 1);

    // Oversize rounds. Each one re-issues the same source (a no-op
    // edit upstream — the source hasn't changed) but with T far past
    // the 2-page document. We do not require a segment to come back;
    // the question is whether the daemon survives.
    for (const t of OVERSIZE_TARGETS) {
      const r = await c.compile({ source: FIXTURE, targetPage: t });
      // The crash signature we are probing for is a protocol
      // violation or child exit surfaced as `r.ok === false` with
      // an error message containing `protocol violation`,
      // `child exited`, or `stdin not writable`.
      if (!r.ok) {
        const msg = r.error ?? "";
        const isCrash =
          /protocol violation/i.test(msg) ||
          /child exited/i.test(msg) ||
          /stdin not writable/i.test(msg);
        if (isCrash) {
          throw new Error(
            `supertex daemon died on recompile,${t} against 2-page doc: ${msg}`,
          );
        }
        // A non-crash error (e.g. a well-formed `[error]` reason
        // from upstream) is acceptable for this probe: the daemon
        // is still alive and the hypothesis remains open.
      }
    }

    // Liveness check: a final in-range round must still succeed.
    // Edit the source so we don't hit the upstream no-op rollback
    // path (which returns `segments: []`).
    const edited = FIXTURE.replace("Page one.", "Page one (edited).");
    await writeFile(join(workDir, "main.tex"), edited);
    const final = await c.compile({ source: edited, targetPage: 1 });
    if (!final.ok) {
      throw new Error(
        `final liveness compile failed after oversize rounds: ${final.error}`,
      );
    }
    assert.equal(final.segments.length, 1);

    // Second probe: the real-world GT-7 trigger is *pasting* a block
    // of `\newpage X` lines. Simulate by growing the document by a
    // large chunk in a single edit and immediately recompiling.
    // This exercises the same control path the browser hits when
    // the user pastes — a fresh source + a single `recompile`, with
    // a large delta vs the previous round.
    const pastedLines = Array.from({ length: 30 }, (_, i) =>
      `\\newpage Page ${i + 3}.`,
    ).join("\n");
    const pasted = `\\documentclass{article}
\\begin{document}
Page one.
\\newpage
Page two.
${pastedLines}
\\end{document}
`;
    await writeFile(join(workDir, "main.tex"), pasted);
    const pasteRound = await c.compile({ source: pasted, targetPage: 1 });
    if (!pasteRound.ok) {
      const msg = pasteRound.error ?? "";
      const isCrash =
        /protocol violation/i.test(msg) ||
        /child exited/i.test(msg) ||
        /stdin not writable/i.test(msg);
      if (isCrash) {
        throw new Error(
          `supertex daemon died on large-paste recompile: ${msg}`,
        );
      }
    }
  } finally {
    await c.close();
  }

  console.log("supertexOversizeTarget.test.mjs: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
