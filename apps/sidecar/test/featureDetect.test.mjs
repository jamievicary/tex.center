// Unit-tests detectSupertexFeatures against fake `supertex --help`
// scripts. Covers: both flags advertised on stdout, only one
// advertised on stderr, neither advertised, and a missing binary.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSupertexFeatures } from "../src/compiler/featureDetect.ts";

const root = mkdtempSync(join(tmpdir(), "supertex-detect-test-"));

function writeBin(name, body) {
  const p = join(root, name);
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const stdoutBoth = writeBin(
  "both.mjs",
  `#!/usr/bin/env node
process.stdout.write("usage: supertex [options]\\n");
process.stdout.write("  --target-page=N   stop after page\\n");
process.stdout.write("  --ready-marker STRING   end-of-round line\\n");
`,
);

const stderrOne = writeBin(
  "stderr-one.mjs",
  `#!/usr/bin/env node
process.stderr.write("usage: supertex [options]\\n");
process.stderr.write("  --target-page=N   stop after page\\n");
process.exit(0);
`,
);

const neither = writeBin(
  "none.mjs",
  `#!/usr/bin/env node
process.stdout.write("usage: supertex paper.tex\\n");
process.stdout.write("  --output-directory DIR\\n");
process.stdout.write("  --live-shipouts FILE\\n");
`,
);

// 1. Both flags advertised on stdout.
{
  const f = await detectSupertexFeatures(stdoutBoth, { timeoutMs: 3_000 });
  assert.deepEqual(f, { readyMarker: true, targetPage: true });
}

// 2. Only --target-page advertised, on stderr.
{
  const f = await detectSupertexFeatures(stderrOne, { timeoutMs: 3_000 });
  assert.deepEqual(f, { readyMarker: false, targetPage: true });
}

// 3. Neither flag mentioned.
{
  const f = await detectSupertexFeatures(neither, { timeoutMs: 3_000 });
  assert.deepEqual(f, { readyMarker: false, targetPage: false });
}

// 4. Missing binary degrades to "no features", does not throw.
{
  const f = await detectSupertexFeatures(join(root, "definitely-not-here"), {
    timeoutMs: 3_000,
  });
  assert.deepEqual(f, { readyMarker: false, targetPage: false });
}

console.log("feature detect test: OK");
