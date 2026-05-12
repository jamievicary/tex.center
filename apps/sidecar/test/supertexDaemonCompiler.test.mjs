// Unit tests for SupertexDaemonCompiler against a fake `supertex
// --daemon` binary. The fake mirrors the upstream protocol just
// closely enough to exercise the compiler's state machine:
//
//   - On startup: clear DIR (the real daemon does this), emit
//     `supertex: daemon ready` on stderr.
//   - On each `recompile,<N|end>` line read from stdin: write
//     chunk files `0.out`..`K.out` into DIR, print `[i.out]` for
//     each, then `[round-done]`. `N=end` → K=total-1. `N` numeric
//     → K=min(N-1, total-1).
//   - Env switches let individual tests force `[error reason]`,
//     a protocol violation, or a hang.
//   - On stdin EOF: exit 0.
//
// We never run the real `supertex` binary here; the C-side
// integration story is M7.5.5.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SupertexDaemonCompiler } from "../src/compiler/supertexDaemon.ts";

const FAKE_DAEMON = `#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const di = argv.indexOf("--daemon");
if (di < 0 || !argv[di + 1]) {
  process.stderr.write("fake-daemon: missing --daemon DIR\\n");
  process.exit(2);
}
const dir = argv[di + 1];
mkdirSync(dir, { recursive: true });
// Clear DIR on startup (binding constraint).
for (const e of readdirSync(dir)) unlinkSync(join(dir, e));

const total = parseInt(process.env.FAKE_TOTAL ?? "3", 10);
const mode = process.env.FAKE_MODE ?? "ok"; // ok | error | violation | hang | exit-mid
const exitOn = process.env.FAKE_EXIT_AFTER ?? ""; // count of rounds before exit

let rounds = 0;
process.stderr.write("supertex: daemon ready\\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handleLine(line);
  }
});
process.stdin.on("end", () => { process.exit(0); });

function handleLine(line) {
  const m = /^recompile,(end|\\d+)$/.exec(line);
  if (!m) { process.stderr.write("fake-daemon: bad line: " + line + "\\n"); process.exit(3); }
  rounds++;
  if (mode === "violation") {
    process.stdout.write("garbage-line\\n");
    return;
  }
  if (mode === "hang") {
    return; // never emit round-done
  }
  if (mode === "exit-mid" && exitOn && rounds >= parseInt(exitOn, 10)) {
    process.exit(7);
  }
  const target = m[1] === "end" ? total - 1 : Math.min(parseInt(m[1], 10) - 1, total - 1);
  for (let i = 0; i <= target; i++) {
    writeFileSync(join(dir, i + ".out"), "CHUNK-" + i + "\\n");
    process.stdout.write("[" + i + ".out]\\n");
  }
  if (mode === "error") {
    process.stdout.write("[error simulated failure]\\n");
  }
  process.stdout.write("[round-done]\\n");
}
`;

const here = mkdtempSync(join(tmpdir(), "supertex-daemon-test-"));
const fakeBin = join(here, "fake-daemon.mjs");
writeFileSync(fakeBin, FAKE_DAEMON, { mode: 0o755 });
chmodSync(fakeBin, 0o755);

async function makeWorkDir(name) {
  const d = join(here, name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "main.tex"), "\\documentclass{article}\\begin{document}hi\\end{document}");
  return d;
}

// Wrap fake-daemon in a Node spawn so we can inject FAKE_* env vars.
function makeSpawnFn(envOverrides = {}) {
  return (_command, args, options) => {
    const { spawn } = require("node:child_process");
    return spawn(process.execPath, [fakeBin, ...args], {
      ...options,
      env: { ...process.env, ...envOverrides },
    });
  };
}
// `require` shim for ESM (we need spawn but stay top-of-file).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// 1. Happy path: spawn lazy, ready marker, one round, chunks concatenated.
{
  const workDir = await makeWorkDir("happy");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "3" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
  });
  const r = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r.ok, true, "happy compile ok");
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.equal(seg.offset, 0);
  assert.equal(seg.totalLength, seg.bytes.length);
  const text = Buffer.from(seg.bytes).toString("utf8");
  assert.match(text, /^CHUNK-0\nCHUNK-1\nCHUNK-2\n$/);
  // Chunk files on disk.
  const onDisk = readdirSync(join(workDir, "chunks")).sort();
  assert.deepEqual(onDisk, ["0.out", "1.out", "2.out"]);
  await c.close();
}

// 2. targetPage clamps via `recompile,N`: requesting 2 yields 2 chunks (0,1).
{
  const workDir = await makeWorkDir("target");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "5" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
  });
  const r = await c.compile({ source: "x", targetPage: 2 });
  assert.equal(r.ok, true);
  const text = Buffer.from(r.segments[0].bytes).toString("utf8");
  assert.match(text, /^CHUNK-0\nCHUNK-1\n$/);
  await c.close();
}

// 3. Persistent process: two compile calls reuse the same child.
{
  const workDir = await makeWorkDir("persistent");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "2" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
  });
  const r1 = await c.compile({ source: "x", targetPage: 0 });
  const r2 = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  await c.close();
}

// 4. `[error reason]` followed by `[round-done]` → CompileFailure
//    surfacing the reason, then a subsequent compile succeeds.
{
  const workDir = await makeWorkDir("error-recover");
  // Two-stage: first compile with FAKE_MODE=error, then would-be
  // recovery. But spawnFn env is fixed per-instance, so we just
  // assert the error surface here; recovery is exercised in
  // M7.5.5 integration tests.
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "1", FAKE_MODE: "error" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
  });
  const r = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /simulated failure/);
  await c.close();
}

// 5. Protocol violation → kills child and surfaces raw line.
{
  const workDir = await makeWorkDir("violation");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "1", FAKE_MODE: "violation" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
  });
  const r = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /protocol violation.*garbage-line/);
  await c.close();
}

// 6. Round timeout fires when daemon never emits round-done.
{
  const workDir = await makeWorkDir("hang");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "1", FAKE_MODE: "hang" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 300,
  });
  const r = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /round timed out/);
  await c.close();
}

// 7. close() is idempotent and terminates the child.
{
  const workDir = await makeWorkDir("close-idempotent");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "1" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 5_000,
    gracefulTimeoutMs: 500,
    killTimeoutMs: 500,
  });
  await c.compile({ source: "x", targetPage: 0 });
  await c.close();
  await c.close();
}

// 8. Concurrent compile rejected.
{
  const workDir = await makeWorkDir("concurrent");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: fakeBin,
    spawnFn: makeSpawnFn({ FAKE_TOTAL: "1", FAKE_MODE: "hang" }),
    readyTimeoutMs: 5_000,
    roundTimeoutMs: 200,
  });
  const p1 = c.compile({ source: "x", targetPage: 0 });
  const r2 = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /another compile already in flight/);
  await p1; // let the first one settle (timeout)
  await c.close();
}

// 9. Spawn ENOENT surfaces as failure.
{
  const workDir = await makeWorkDir("nobin");
  const c = new SupertexDaemonCompiler({
    workDir,
    supertexBin: join(here, "definitely-missing"),
    readyTimeoutMs: 1_000,
  });
  const r = await c.compile({ source: "x", targetPage: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT|not found|no such file|spawn/i);
  await c.close();
}

console.log("supertex-daemon compiler test: OK");
