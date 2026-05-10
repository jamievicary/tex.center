// Unit-tests SupertexWatchCompiler against a fake long-running
// `supertex` watch binary that:
//   - on startup, reads main.tex, writes a stub PDF whose body
//     records the source bytes, appends a shipouts entry, and
//     emits the READY marker on stdout;
//   - polls main.tex's mtime every 20 ms; on each change, repeats
//     the round (re-read source, rewrite PDF, append shipout,
//     emit READY);
//   - exits cleanly on SIGTERM.
//
// Tests:
//   1. Happy path: spawn, initial compile, read PDF.
//   2. Re-compile after writeMain reflects the new source bytes.
//   3. close() reaps the child (PID gone via process.kill(pid, 0)).
//   4. Timeout when the fake never emits the READY marker.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SupertexWatchCompiler } from "../src/compiler/supertexWatch.ts";
import { ProjectWorkspace } from "../src/workspace.ts";

// Honours $FAKE_SUPPRESS_READY=1 to skip emitting the READY line —
// drives the timeout-path test.
const FAKE_WATCHER = `#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync, statSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const sourcePath = args[0];
let outDir = null;
let shipouts = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--output-directory") { outDir = args[++i]; continue; }
  if (a === "--live-shipouts") { shipouts = args[++i]; continue; }
  process.stderr.write("fake supertex-watch: unknown arg " + a + "\\n");
  process.exit(2);
}
if (!sourcePath || !outDir) {
  process.stderr.write("fake supertex-watch: missing source/outdir\\n");
  process.exit(3);
}
const READY = "SUPERTEX_READY";
const suppress = process.env.FAKE_SUPPRESS_READY === "1";
const base = basename(sourcePath).replace(/\\.tex$/, "");
let round = 0;

function compileOnce() {
  round += 1;
  let source;
  try { source = readFileSync(sourcePath, "utf8"); }
  catch (e) { process.stderr.write("read fail: " + e.message + "\\n"); return; }
  mkdirSync(outDir, { recursive: true });
  const pdf =
    "%PDF-1.4\\n% round=" + round +
    "\\n% src-bytes=" + Buffer.byteLength(source, "utf8") +
    "\\n% src=" + source.replace(/[\\r\\n]/g, " ") +
    "\\n%%EOF\\n";
  writeFileSync(join(outDir, base + ".pdf"), pdf);
  if (shipouts) appendFileSync(shipouts, round + "\\t0\\n");
  if (!suppress) {
    // Important: write+\\n so the line lands as one stdout chunk.
    process.stdout.write(READY + "\\n");
  }
}

let lastMtime = 0;
try { lastMtime = statSync(sourcePath).mtimeMs; } catch {}

compileOnce();

let alive = true;
const term = (sig) => () => {
  alive = false;
  // Exit on next tick so any pending stdout flushes.
  setImmediate(() => process.exit(0));
};
process.on("SIGTERM", term("SIGTERM"));
process.on("SIGINT", term("SIGINT"));

setInterval(() => {
  if (!alive) return;
  let m;
  try { m = statSync(sourcePath).mtimeMs; }
  catch { return; }
  if (m !== lastMtime) {
    lastMtime = m;
    compileOnce();
  }
}, 20);
`;

const root = mkdtempSync(join(tmpdir(), "supertex-watch-test-"));
const fakeBin = join(root, "fake-watch.mjs");
writeFileSync(fakeBin, FAKE_WATCHER, { mode: 0o755 });
chmodSync(fakeBin, 0o755);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}

async function waitFor(pred, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// 1 + 2: happy path + re-compile after edit.
{
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "happy" });
  await ws.writeMain("\\\\documentclass{article}\\\\begin{document}round one\\\\end{document}");
  const c = new SupertexWatchCompiler({ workDir: ws.dir, supertexBin: fakeBin, timeoutMs: 5_000 });
  const r1 = await c.compile({ source: "ignored", targetPage: 1 });
  assert.equal(r1.ok, true, "first compile expected ok: " + (r1.ok ? "" : r1.error));
  assert.equal(r1.segments.length, 1);
  const t1 = Buffer.from(r1.segments[0].bytes).toString("utf8");
  assert.match(t1, /round=1/, "first round marker");
  assert.match(t1, /round one/, "first source bytes");

  // Edit the source — simulate the server's writeMain between compiles.
  await ws.writeMain("\\\\documentclass{article}\\\\begin{document}round two\\\\end{document}");
  const r2 = await c.compile({ source: "ignored", targetPage: 1 });
  assert.equal(r2.ok, true, "second compile expected ok: " + (r2.ok ? "" : r2.error));
  const t2 = Buffer.from(r2.segments[0].bytes).toString("utf8");
  assert.match(t2, /round=2/, "second round marker");
  assert.match(t2, /round two/, "updated source bytes");

  // Shipouts file accumulated two lines.
  const ship = readFileSync(join(ws.dir, "out", "shipouts"), "utf8").trim().split("\n");
  assert.equal(ship.length, 2);

  // 3: pid is alive before close, gone after.
  const pid = c.pid();
  assert.equal(typeof pid, "number");
  assert.equal(pidAlive(pid), true, "child should be alive before close");
  await c.close();
  // The OS may take a brief moment to reap; the compiler awaits exit
  // but `kill(0)` against a freshly-reaped pid still throws ESRCH.
  const gone = await waitFor(() => !pidAlive(pid), 2_000);
  assert.equal(gone, true, "child should be gone after close()");
  await ws.dispose();
}

// 4: timeout when the fake never emits READY.
{
  const ws = new ProjectWorkspace({ rootDir: root, projectId: "timeout" });
  await ws.writeMain("x");
  const wrapper = join(root, "no-ready-wrap.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(fakeBin)}, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, FAKE_SUPPRESS_READY: "1" },
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
`,
    { mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);
  const c = new SupertexWatchCompiler({
    workDir: ws.dir,
    supertexBin: wrapper,
    timeoutMs: 200,
  });
  const r = await c.compile({ source: "x", targetPage: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  await c.close();
  await ws.dispose();
}

console.log("supertex-watch compiler test: OK");
