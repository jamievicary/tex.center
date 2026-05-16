// Iter 372 / M21 iter B: `WsClientSnapshot.pdfLastPage` mirrors the
// most recent `pdf-segment.lastPage` wire field (iter-370 tri-state
// `boolean | undefined`). PdfViewer reads this prop to decide
// whether to mount the demand-fetch placeholder slot — a regression
// that silently dropped the field would leave the FE wedged at
// page 1 forever on multi-page documents.

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

function snapshotsAfter(segments) {
  FakeWebSocket.instances = [];
  const snaps = [];
  const client = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const ws = FakeWebSocket.instances[0];
  for (const seg of segments) {
    ws.dispatchMessage(encodePdfSegment(seg));
  }
  client.destroy();
  return snaps;
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

// Case 1: lastPage===false ⇒ snapshot.pdfLastPage === false.
{
  const snaps = snapshotsAfter([
    { totalLength: bytes.length, offset: 0, bytes, lastPage: false },
  ]);
  const last = snaps.filter((s) => s.pdfBytes !== null).pop();
  assert.ok(last, "expected at least one pdf-bearing snapshot");
  assert.equal(
    last.pdfLastPage,
    false,
    "snapshot.pdfLastPage must mirror the wire false (demand-fetch placeholder gate)",
  );
}

// Case 2: lastPage===true ⇒ snapshot.pdfLastPage === true.
{
  const snaps = snapshotsAfter([
    { totalLength: bytes.length, offset: 0, bytes, lastPage: true },
  ]);
  const last = snaps.filter((s) => s.pdfBytes !== null).pop();
  assert.equal(last.pdfLastPage, true, "wire true must surface as true");
}

// Case 3: no `lastPage` field (compiler does not expose the signal)
// ⇒ snapshot.pdfLastPage is undefined.
{
  const snaps = snapshotsAfter([
    { totalLength: bytes.length, offset: 0, bytes },
  ]);
  const last = snaps.filter((s) => s.pdfBytes !== null).pop();
  assert.equal(
    last.pdfLastPage,
    undefined,
    "absent `lastPage` on wire must surface as undefined " +
      "(PdfViewer leaves the placeholder slot closed in this case)",
  );
}

// Case 4: a fresh segment's `lastPage` REPLACES the previous value.
// A `false → true` flip ends the cascade; without this replacement,
// the FE would keep mounting placeholders past `\enddocument`.
{
  const snaps = snapshotsAfter([
    { totalLength: bytes.length, offset: 0, bytes, lastPage: false },
    { totalLength: bytes.length, offset: 0, bytes, lastPage: true },
  ]);
  const pdfSnaps = snaps.filter((s) => s.pdfBytes !== null);
  assert.ok(pdfSnaps.length >= 2);
  assert.equal(
    pdfSnaps[pdfSnaps.length - 2].pdfLastPage,
    false,
    "first snapshot reflects the first segment's false",
  );
  assert.equal(
    pdfSnaps[pdfSnaps.length - 1].pdfLastPage,
    true,
    "second snapshot reflects the second segment's true (cascade end)",
  );
}

console.log("wsClientLastPage: ok");
