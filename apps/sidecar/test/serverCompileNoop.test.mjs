// Asserts the sidecar's compile-no-op wire + log path. A
// compiler returning `{ ok: true, segments: [], noopReason: "..." }`
// (the upstream-supertex "no usable rollback target" round-shape
// from `apps/sidecar/src/compiler/supertexDaemon.ts` line ~141)
// must still close out the wire with a `compile-status:idle`
// frame, MUST NOT push a pdf-segment, and MUST surface the
// reason in app-logs at warn level so the failure is diagnosable
// from `flyctl logs` alone. This is the wire/log half of the
// GT-5 diagnosis (sidecar saw round-done idle but shipped no
// PDF) — kept here rather than the daemon-compiler test because
// the log is the server's responsibility.
//
// See `.autodev/logs/228.md` for the GT-5 trace this pins.

import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { startServer, bootClient, closeClient, waitFor } from "./lib.mjs";

class StubNoopCompiler {
  async compile() {
    return {
      ok: true,
      segments: [],
      noopReason: "stub noop: no usable rollback target",
    };
  }
  async close() {}
}

const logLines = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    const s = chunk.toString("utf8");
    for (const line of s.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        logLines.push(JSON.parse(line));
      } catch {
        // ignore non-JSON pino frames
      }
    }
    cb();
  },
});

const app = await startServer({
  compilerFactory: () => new StubNoopCompiler(),
  logger: { level: "info", stream: logStream },
});

const { ws, frames } = await bootClient(app, "test");

await waitFor(
  () =>
    frames.some(
      (f) =>
        f.kind === "control" &&
        f.message.type === "compile-status" &&
        f.message.state === "idle",
    ),
  "compile-status:idle frame after no-op compile",
  frames,
);

// No pdf-segment for a no-op compile — that's the whole point of
// the noopReason path (synthesising one would be the iter-188
// edit→preview regression class).
assert.equal(
  frames.some((f) => f.kind === "pdf-segment"),
  false,
  "no pdf-segment expected for a no-op compile",
);

// And no compile-status:error either — the compile succeeded; it
// just produced no delta.
assert.equal(
  frames.some(
    (f) =>
      f.kind === "control" &&
      f.message.type === "compile-status" &&
      f.message.state === "error",
  ),
  false,
  "no compile-status:error expected for a no-op compile",
);

// The noopReason must surface in app-logs at warn level so the
// next live GT-5-class failure is diagnosable from flyctl logs.
// pino warn level is 40.
await waitFor(
  () =>
    logLines.some(
      (r) => r.level === 40 && typeof r.msg === "string" && r.msg.includes("no-op"),
    ),
  "noop compile warn-log line",
  logLines,
);
const noopWarn = logLines.find(
  (r) => r.level === 40 && typeof r.msg === "string" && r.msg.includes("no-op"),
);
assert.equal(
  noopWarn.noopReason,
  "stub noop: no usable rollback target",
  "noopReason field propagated to log record",
);
assert.equal(noopWarn.projectId, "test", "projectId in log record");

await closeClient(ws, app);

console.log("sidecar compile-noop wire+log test: OK");
