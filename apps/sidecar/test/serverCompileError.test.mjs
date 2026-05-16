// Asserts the sidecar's compile-status:error wire path. Injects
// a stub compiler that returns { ok: false, error: <reason> }, and
// confirms the client receives a `compile-status` control frame
// with `state: "error"` and `detail: <reason>`. This is the wire
// half of M7.5.3 — the daemon compiler emits the same failure
// shape on `[error <reason>]` (see supertexDaemonCompiler.test.mjs
// "error+round-done" case), so a single sidecar-level assertion
// covers the full daemon → wire chain without needing a real
// supertex ELF.

import assert from "node:assert/strict";

import { startServer, bootClient, closeClient, waitFor } from "./lib.mjs";

class StubErrorCompiler {
  async compile() {
    return { ok: false, error: "boom from stub" };
  }
  async close() {}
  async warmup() {}
}

const app = await startServer({
  compilerFactory: () => new StubErrorCompiler(),
});

const { ws, frames } = await bootClient(app, "test");

await waitFor(
  () =>
    frames.some(
      (f) =>
        f.kind === "control" &&
        f.message.type === "compile-status" &&
        f.message.state === "error" &&
        f.message.detail === "boom from stub",
    ),
  "compile-status:error frame with detail",
  frames,
);

// No PDF segment should have been pushed for a failed compile.
assert.equal(
  frames.some((f) => f.kind === "pdf-segment"),
  false,
  "no pdf-segment expected for a failed compile",
);

// And the running→error transition implies no idle frame either.
assert.equal(
  frames.some(
    (f) =>
      f.kind === "control" &&
      f.message.type === "compile-status" &&
      f.message.state === "idle",
  ),
  false,
  "no compile-status:idle expected when compile fails",
);

await closeClient(ws, app);

console.log("sidecar compile-error wire test: OK");
