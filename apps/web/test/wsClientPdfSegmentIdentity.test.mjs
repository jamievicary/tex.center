// Iter-188 regression guard: every observed `pdf-segment` frame
// must produce a snapshot whose `pdfBytes` field has a *new*
// reference, even when the underlying bytes are byte-identical to
// the prior frame.
//
// `188_answer.md` rules out hypothesis 3 (stale Uint8Array
// reference) as the cause of the user-visible "preview never
// updates" bug — `PdfBuffer.applySegment` returns a fresh
// `Uint8Array` via `snapshot()` on every call. This unit test
// locks that invariant in: a future optimisation that dedupes
// by content-equality (e.g. returning the same Uint8Array when
// totalLength+offset+bytes match the prior segment) would break
// PdfViewer.svelte's `$effect` retrigger and reproduce the
// user-visible regression. Failing here trips the harness revert.

import assert from "node:assert/strict";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  binaryType = "blob";
  url;
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  dispatchMessage(bytes) {
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.buffer.slice(0) }),
    );
  }
}
globalThis.WebSocket = FakeWebSocket;

const { WsClient } = await import("../src/lib/wsClient.ts");
const { encodePdfSegment } = await import("@tex-center/protocol");

// Case 1: two byte-identical pdf-segment frames produce snapshots
// whose `pdfBytes` are reference-distinct (and content-equal).
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const client = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const ws = FakeWebSocket.instances[0];
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const frame = encodePdfSegment({
    totalLength: bytes.length,
    offset: 0,
    bytes,
  });
  ws.dispatchMessage(frame);
  ws.dispatchMessage(frame);

  const pdfSnaps = snaps.filter((s) => s.pdfBytes !== null);
  assert.ok(
    pdfSnaps.length >= 2,
    `expected at least two pdf-bearing snapshots, got ${pdfSnaps.length}`,
  );
  const a = pdfSnaps[pdfSnaps.length - 2].pdfBytes;
  const b = pdfSnaps[pdfSnaps.length - 1].pdfBytes;
  assert.notEqual(
    a,
    b,
    "snapshot.pdfBytes reference must change on every pdf-segment frame " +
      "(PdfViewer.svelte's $effect relies on identity change to re-render)",
  );
  assert.deepEqual(
    a,
    b,
    "byte-identical input frames should produce byte-identical pdfBytes",
  );
  client.destroy();
}

// Case 2: pdfBytes reference also changes when the second frame
// genuinely patches a sub-range — sanity check the common case.
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const client = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const ws = FakeWebSocket.instances[0];
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: 4,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3, 4]),
    }),
  );
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: 4,
      offset: 2,
      bytes: new Uint8Array([9, 9]),
    }),
  );
  const pdfSnaps = snaps.filter((s) => s.pdfBytes !== null);
  const a = pdfSnaps[pdfSnaps.length - 2].pdfBytes;
  const b = pdfSnaps[pdfSnaps.length - 1].pdfBytes;
  assert.notEqual(a, b);
  assert.deepEqual(b, new Uint8Array([1, 2, 9, 9]));
  client.destroy();
}

console.log("wsClientPdfSegmentIdentity: ok");
