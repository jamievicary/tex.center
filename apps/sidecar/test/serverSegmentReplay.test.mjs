// A fresh WS subscriber on a project that already produced a
// pdf-segment must receive that segment on connect, without
// requiring an edit or a fresh source compile.
//
// Motivating bug: the live gold specs GT-B/C/D/5 each connect to
// a project that the shared warm-up has already compiled. The
// supertex daemon short-circuits an unchanged-source `recompile`
// to `{segments: []}`, so without server-side replay a new
// viewer never sees the initial PDF.

import assert from "node:assert/strict";

import { bootClient, closeClient, startServer, waitFor } from "./lib.mjs";

const STUB_PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, // "%PDF-1.4\n"
]);

// On the first compile, emit a segment. On every subsequent
// compile, return `{segments: []}` — mimicking the daemon's
// unchanged-source short-circuit.
class OneShotCompiler {
  constructor() {
    this.compileCount = 0;
  }
  async compile() {
    this.compileCount += 1;
    if (this.compileCount === 1) {
      return {
        ok: true,
        segments: [{ totalLength: STUB_PDF.length, offset: 0, bytes: STUB_PDF }],
      };
    }
    return { ok: true, segments: [] };
  }
  async close() {}
  async warmup() {}
  async snapshot() { return null; }
  async restore() {}
}

const compilers = [];
const app = await startServer({
  compilerFactory: () => {
    const c = new OneShotCompiler();
    compilers.push(c);
    return c;
  },
});

const projectId = "replay";

// First client: triggers the initial compile and observes the
// first (and only ever produced) pdf-segment.
const c1 = await bootClient(app, projectId);
await waitFor(
  () => c1.frames.some((f) => f.kind === "pdf-segment"),
  "first client gets pdf-segment",
  c1.frames,
);
const firstSeg = c1.frames.find((f) => f.kind === "pdf-segment");
assert.equal(firstSeg.segment.totalLength, STUB_PDF.length);

// Close the first client; the project state stays in the sidecar.
c1.ws.close();
await new Promise((r) => c1.ws.once("close", r));

// Second client: connects to the same project. The compiler is
// "warm" — its second compile (kicked by the new connection)
// returns segments:[]. The cached segment must be replayed.
const c2 = await bootClient(app, projectId);
await waitFor(
  () => c2.frames.some((f) => f.kind === "pdf-segment"),
  "second client receives replayed pdf-segment",
  c2.frames,
);
const replaySeg = c2.frames.find((f) => f.kind === "pdf-segment");
assert.equal(replaySeg.segment.totalLength, STUB_PDF.length);
assert.equal(replaySeg.segment.offset, 0);
assert.deepEqual(Array.from(replaySeg.segment.bytes), Array.from(STUB_PDF));

// The replay should not depend on the no-op second compile
// producing a frame — by the time we got the segment above, the
// compile may or may not have completed. But it must have been
// triggered (coalescer.kick on connect).
await waitFor(
  () => compilers[0].compileCount >= 2,
  "second compile kicked on reconnect",
  c2.frames,
);

await closeClient(c2.ws, app);
console.log("ok serverSegmentReplay");
