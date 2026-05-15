// M15 Step A pin. Asserts the sidecar emits structured
// `compile-source` records describing the source content it hands
// to the compiler on each compile, plus that the
// `SupertexDaemonCompiler` emits `daemon-stdin` and `daemon-stderr`
// records for each round / each stderr line. Both are gated on a
// `compileDebugLog` (or env `DEBUG_COMPILE_LOG`) sink, so a test
// recorder is enough to pin the contract end-to-end.
//
// The intent of this contract is operational: a future M15 Step C
// `flyctl logs` scrape needs `sourceSha256`, `sourceHead`,
// `sourceTail`, `endDocPos` per compile to settle whether the
// page-1-only PDF bug is daemon-side or client-side. Drift in
// field names, types, or shapes here would silently break that
// scrape; the test is the lock.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, bootClient, closeClient, waitFor, makeBlobStore, seedMainTex } from "./lib.mjs";
import { SupertexDaemonCompiler } from "../src/compiler/supertexDaemon.ts";

class StubCompiler {
  async compile() { return { ok: true, segments: [] }; }
  async close() {}
  async snapshot() { return null; }
  async restore() {}
}

// ---------- Case 1: server-side `compile-source` record. ----------
{
  const records = [];
  const { blobStore } = makeBlobStore("compile-source-log");
  const SOURCE =
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    "Hello, world!\n" +
    "\\end{document}\n";
  await seedMainTex(blobStore, "p1", SOURCE);

  const app = await startServer({
    blobStore,
    compilerFactory: () => new StubCompiler(),
    compileDebugLog: (fields, msg) => records.push({ msg, ...fields }),
  });
  const { ws, frames } = await bootClient(app, "p1");
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "idle",
      ),
    "compile-status:idle after first compile",
    frames,
  );

  const compileSource = records.find((r) => r.msg === "compile-source");
  assert.ok(
    compileSource,
    `compile-source record missing; got msgs=${JSON.stringify(records.map((r) => r.msg))}`,
  );
  assert.equal(compileSource.projectId, "p1", "projectId attached");
  assert.equal(typeof compileSource.sourceLen, "number");
  assert.equal(compileSource.sourceLen, SOURCE.length);
  assert.equal(compileSource.sourceBytes, Buffer.byteLength(SOURCE, "utf8"));
  assert.equal(typeof compileSource.sourceSha256, "string");
  assert.equal(
    compileSource.sourceSha256.length,
    64,
    "sha256 hex digest is 64 chars",
  );
  assert.match(compileSource.sourceSha256, /^[0-9a-f]{64}$/);
  // Head is the first 80 bytes; for a source <80 bytes this is the
  // whole thing. Our SOURCE is 67 bytes so head==SOURCE.
  assert.equal(compileSource.sourceHead, SOURCE);
  // Tail is the last 80 bytes; same for sources < 80B.
  assert.equal(compileSource.sourceTail, SOURCE);
  // endDocPos is the byte offset of `\end{document}` in the source.
  const expectedEndDoc = Buffer.from(SOURCE).indexOf(
    Buffer.from("\\end{document}"),
  );
  assert.equal(compileSource.endDocPos, expectedEndDoc);
  assert.ok(expectedEndDoc > 0, "sanity: \\end{document} present");

  await closeClient(ws, app);
  console.log("ok 1 — compile-source record shape");
}

// ---------- Case 2: source > 80 bytes → head/tail are the
// boundary slices, sha256 still matches the full bytes. ----------
{
  const records = [];
  const filler = "x".repeat(120);
  const SOURCE =
    "\\documentclass{article}\n" +
    "\\begin{document}\n" +
    filler + "\n" +
    "\\end{document}\n";
  const { blobStore } = makeBlobStore("compile-source-log-long");
  await seedMainTex(blobStore, "p2", SOURCE);

  const app = await startServer({
    blobStore,
    compilerFactory: () => new StubCompiler(),
    compileDebugLog: (fields, msg) => records.push({ msg, ...fields }),
  });
  const { ws, frames } = await bootClient(app, "p2");
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "idle",
      ),
    "compile-status:idle for long source",
    frames,
  );

  const compileSource = records.find((r) => r.msg === "compile-source");
  assert.ok(compileSource);
  assert.equal(
    compileSource.sourceHead,
    Buffer.from(SOURCE).subarray(0, 80).toString("utf8"),
    "head is exactly 80 bytes",
  );
  assert.equal(
    Buffer.byteLength(compileSource.sourceHead, "utf8"),
    80,
  );
  assert.equal(
    compileSource.sourceTail,
    Buffer.from(SOURCE)
      .subarray(Buffer.byteLength(SOURCE, "utf8") - 80)
      .toString("utf8"),
    "tail is exactly the last 80 bytes",
  );
  assert.equal(
    Buffer.byteLength(compileSource.sourceTail, "utf8"),
    80,
  );

  await closeClient(ws, app);
  console.log("ok 2 — head/tail slice on source >80B");
}

// ---------- Case 3: missing `\end{document}` → endDocPos = -1. ----
{
  const records = [];
  const SOURCE = "no end document marker here\n";
  const { blobStore } = makeBlobStore("compile-source-log-noend");
  await seedMainTex(blobStore, "p3", SOURCE);

  const app = await startServer({
    blobStore,
    compilerFactory: () => new StubCompiler(),
    compileDebugLog: (fields, msg) => records.push({ msg, ...fields }),
  });
  const { ws, frames } = await bootClient(app, "p3");
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.kind === "control" &&
          f.message.type === "compile-status" &&
          f.message.state === "idle",
      ),
    "compile-status:idle for no-end source",
    frames,
  );

  const compileSource = records.find((r) => r.msg === "compile-source");
  assert.ok(compileSource);
  assert.equal(compileSource.endDocPos, -1, "missing \\end{document} surfaces as -1");

  await closeClient(ws, app);
  console.log("ok 3 — endDocPos=-1 when marker absent");
}

// ---------- Case 4: env / opts both off → no records emitted. ----
{
  const records = [];
  const { blobStore } = makeBlobStore("compile-source-log-off");
  await seedMainTex(blobStore, "p4", "x\n");
  const prev = process.env.DEBUG_COMPILE_LOG;
  process.env.DEBUG_COMPILE_LOG = "0";
  try {
    const app = await startServer({
      blobStore,
      compilerFactory: () => new StubCompiler(),
      // No compileDebugLog override; env says off.
    });
    const { ws, frames } = await bootClient(app, "p4");
    await waitFor(
      () =>
        frames.some(
          (f) =>
            f.kind === "control" &&
            f.message.type === "compile-status" &&
            f.message.state === "idle",
        ),
      "compile-status:idle with DEBUG_COMPILE_LOG=0",
      frames,
    );
    assert.equal(records.length, 0, "no records when sink unwired");
    await closeClient(ws, app);
  } finally {
    if (prev === undefined) delete process.env.DEBUG_COMPILE_LOG;
    else process.env.DEBUG_COMPILE_LOG = prev;
  }
  console.log("ok 4 — DEBUG_COMPILE_LOG=0 silences the sink");
}

// ---------- Case 5: SupertexDaemonCompiler emits `daemon-stdin` +
// `daemon-stderr` records via its `log` option. Uses the existing
// fake-daemon shell from supertexDaemonCompiler.test.mjs (inlined
// here so this file remains independently runnable). ----------
{
  const records = [];
  const FAKE_DAEMON = `#!/usr/bin/env node
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const di = argv.indexOf("--daemon");
const dir = argv[di + 1];
mkdirSync(dir, { recursive: true });
for (const e of readdirSync(dir)) unlinkSync(join(dir, e));
process.stderr.write("supertex: daemon ready\\n");
process.stderr.write("preflight: ok\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    process.stderr.write("got: " + line + "\\n");
    writeFileSync(join(dir, "1.out"), Buffer.from("%PDF-1.4 ok"));
    process.stdout.write("[1.out]\\n[round-done]\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

  const work = mkdtempSync(join(tmpdir(), "daemon-debug-log-"));
  const bin = join(work, "fake-daemon.mjs");
  writeFileSync(bin, FAKE_DAEMON);
  chmodSync(bin, 0o755);
  // Touch the source file so the spawn args reference an existing
  // path; the fake daemon doesn't read it.
  writeFileSync(join(work, "main.tex"), "x");

  const compiler = new SupertexDaemonCompiler({
    workDir: work,
    supertexBin: bin,
    log: (fields, msg) => records.push({ msg, ...fields }),
    projectId: "p-daemon",
  });
  const result = await compiler.compile({ source: "x", targetPage: 0 });
  assert.equal(result.ok, true, "fake daemon round succeeds");
  await compiler.close();

  const stdin = records.find((r) => r.msg === "daemon-stdin");
  assert.ok(
    stdin,
    `daemon-stdin record missing; got=${JSON.stringify(records.map((r) => r.msg))}`,
  );
  assert.equal(stdin.projectId, "p-daemon");
  assert.equal(stdin.target, "end", "targetPage=0 → 'end'");
  assert.equal(stdin.round, 1);
  assert.equal(stdin.sourceLen, 1);

  const stderrs = records.filter((r) => r.msg === "daemon-stderr");
  assert.ok(stderrs.length >= 2, `expected ≥2 daemon-stderr records, got ${stderrs.length}`);
  assert.ok(
    stderrs.some((r) => r.line === "supertex: daemon ready"),
    "ready marker line forwarded",
  );
  assert.ok(
    stderrs.some((r) => r.line === "got: recompile,end"),
    "per-round echo line forwarded",
  );
  for (const r of stderrs) {
    assert.equal(r.projectId, "p-daemon");
    assert.equal(typeof r.line, "string");
    assert.ok(!r.line.includes("\n"), "line is one stderr line, no embedded newline");
  }
  console.log("ok 5 — daemon-stdin + daemon-stderr records");
}

console.log("serverCompileSourceLog.test.mjs: PASS");
