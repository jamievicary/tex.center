// Asserts the sidecar's compile-no-op wire path. A compiler
// returning `{ ok: true, segments: [] }` (the upstream-supertex
// "no usable rollback target" round-shape from
// `apps/sidecar/src/compiler/supertexDaemon.ts`) must still close
// out the wire with a `compile-status:idle` frame and MUST NOT
// push a pdf-segment. This is the wire half of the iter-188
// edit→preview regression class (synthesising a segment from
// stale chunks would mask the upstream no-op as a byte-identical
// "fresh" PDF).

import assert from "node:assert/strict";

import { startServer, bootClient, closeClient, waitFor } from "./lib.mjs";

class StubNoopCompiler {
  async compile() {
    return { ok: true, segments: [] };
  }
  async close() {}
}

const app = await startServer({
  compilerFactory: () => new StubNoopCompiler(),
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

assert.equal(
  frames.some((f) => f.kind === "pdf-segment"),
  false,
  "no pdf-segment expected for a no-op compile",
);

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

await closeClient(ws, app);

console.log("sidecar compile-noop wire test: OK");
