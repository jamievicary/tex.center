// Unit-tests SupertexOnceCompiler against a fake `supertex` binary
// — a small Node script that mimics the real CLI's flag parsing
// and writes a stub PDF + shipouts log. Verifies we spawn with the
// right args, parse exit codes, and surface PDF-not-found / engine
// failures as structured CompileFailure values.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SupertexOnceCompiler } from "../src/compiler/supertexOnce.ts";

// Fake `supertex` driver: parses the flags we use, copies the
// source contents into a stub PDF so the test can verify the
// spawned binary actually saw the expected file, and writes a
// trivial shipouts entry. Honours $FAKE_FAIL=1 / $FAKE_NO_PDF=1
// so failure-path tests can opt into specific misbehaviour.
const FAKE_SUPERTEX = `#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

if (process.env.FAKE_FAIL === "1") {
  process.stderr.write("fake supertex: forced failure\\n");
  process.exit(7);
}

const args = process.argv.slice(2);
const sourcePath = args[0];
let outDir = null;
let shipouts = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--once") continue;
  if (a === "--output-directory") { outDir = args[++i]; continue; }
  if (a === "--live-shipouts") { shipouts = args[++i]; continue; }
  process.stderr.write("fake supertex: unknown arg " + a + "\\n");
  process.exit(2);
}
if (!sourcePath || !outDir) {
  process.stderr.write("fake supertex: missing source/outdir\\n");
  process.exit(3);
}
const source = readFileSync(sourcePath, "utf8");
mkdirSync(outDir, { recursive: true });
if (process.env.FAKE_NO_PDF !== "1") {
  const base = basename(sourcePath).replace(/\\.tex$/, "");
  const pdf =
    "%PDF-1.4\\n% src-bytes=" + Buffer.byteLength(source, "utf8") +
    "\\n% src=" + source.replace(/[\\r\\n]/g, " ") +
    "\\n%%EOF\\n";
  writeFileSync(join(outDir, base + ".pdf"), pdf);
}
if (shipouts) writeFileSync(shipouts, "1\\t0\\n");
`;

const here = mkdtempSync(join(tmpdir(), "supertex-once-test-"));
const fakeBin = join(here, "fake-supertex.mjs");
writeFileSync(fakeBin, FAKE_SUPERTEX, { mode: 0o755 });
chmodSync(fakeBin, 0o755);

// 1. Happy path: source on disk, fake produces PDF, compiler returns it.
{
  const workDir = join(here, "happy");
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), "\\\\documentclass{article}\\\\begin{document}hi\\\\end{document}");
  const c = new SupertexOnceCompiler({ workDir, supertexBin: fakeBin });
  const r = await c.compile({ source: "ignored", targetPage: 1 });
  assert.equal(r.ok, true, "happy path expected ok");
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.equal(seg.offset, 0);
  assert.equal(seg.bytes.length, seg.totalLength);
  assert.equal(String.fromCharCode(...seg.bytes.slice(0, 4)), "%PDF");
  // Verify the fake actually saw our source on disk.
  const text = Buffer.from(seg.bytes).toString("utf8");
  assert.match(text, /src-bytes=\d+/);
  assert.match(text, /\\\\documentclass/);
  // Outputs landed in <workDir>/out/.
  assert.match(readFileSync(join(workDir, "out", "shipouts"), "utf8"), /^1\t0/);
  await c.close();
}

// 2. Engine non-zero exit (env-injecting wrapper script).
{
  const wrapper = join(here, "fail-wrap.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(fakeBin)}, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, FAKE_FAIL: "1" },
});
child.on("close", (code) => process.exit(code ?? 1));
`,
    { mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);
  const workDir = join(here, "fail2");
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), "x");
  const c = new SupertexOnceCompiler({ workDir, supertexBin: wrapper });
  const r = await c.compile({ source: "x", targetPage: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /supertex exited 7/);
  assert.match(r.error, /forced failure/);
  await c.close();
}

// 3. PDF missing despite zero exit → structured failure.
{
  const wrapper = join(here, "nopdf-wrap.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(fakeBin)}, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, FAKE_NO_PDF: "1" },
});
child.on("close", (code) => process.exit(code ?? 1));
`,
    { mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);
  const workDir = join(here, "nopdf");
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), "x");
  const c = new SupertexOnceCompiler({ workDir, supertexBin: wrapper });
  const r = await c.compile({ source: "x", targetPage: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /pdf not produced/i);
  await c.close();
}

// 4. Missing binary → structured failure (spawn ENOENT).
{
  const workDir = join(here, "nobin");
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "main.tex"), "x");
  const c = new SupertexOnceCompiler({
    workDir,
    supertexBin: join(here, "definitely-not-here"),
  });
  const r = await c.compile({ source: "x", targetPage: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT|not found|no such file/i);
  await c.close();
}

console.log("supertex-once compiler test: OK");
