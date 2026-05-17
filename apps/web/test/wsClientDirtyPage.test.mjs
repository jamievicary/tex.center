// M27 [dirty D] wire path: `WsClientSnapshot.dirtyFromPage` tracks
// the lowest stale 1-based page index. Combined update rule (see
// `wsClient.ts` handler comments):
//
//   - pdf-segment with shipoutPage T:
//       _highestShipout = max(_highestShipout, T)
//       if dirtyFromPage <= T: dirtyFromPage = T+1
//   - dirty-page control with page D:
//       candidate = max(D, _highestShipout + 1)
//       dirtyFromPage = min(dirtyFromPage ?? candidate, candidate)
//
// The PdfViewer renders a translucent grey overlay + spinner on
// every `.pdf-page` with data-page >= dirtyFromPage. A regression
// here would either silently overlay fresh pages (false-positive
// dirty) or fail to overlay stale ones (false-negative).

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
const { encodePdfSegment, encodeControl } = await import("@tex-center/protocol");

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

function newClient() {
  FakeWebSocket.instances = [];
  const snaps = [];
  const client = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const ws = FakeWebSocket.instances[0];
  return { client, ws, snaps };
}

function lastSnap(snaps) {
  return snaps[snaps.length - 1];
}

// Case 1: cold open — no segments, no dirty events ⇒ dirtyFromPage null.
{
  const { client, snaps } = newClient();
  assert.equal(
    lastSnap(snaps)?.dirtyFromPage ?? null,
    null,
    "fresh client has no dirty pages",
  );
  client.destroy();
}

// Case 2: segment shipoutPage=3 then dirty-page D=1 (preamble edit
// round shape). Combined: dirtyFromPage = max(1, 3+1) = 4.
{
  const { client, ws, snaps } = newClient();
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 3,
      lastPage: false,
    }),
  );
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 1 }));
  assert.equal(
    lastSnap(snaps).dirtyFromPage,
    4,
    "segment(T=3) then dirty(D=1) ⇒ frontier at first unshipped page (4)",
  );
  client.destroy();
}

// Case 3: dirty-page D higher than any segment so far ⇒ frontier = D.
// User on page 1 (T=1) edits page 7. dirtyFromPage = max(7, 2) = 7.
{
  const { client, ws, snaps } = newClient();
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 1,
    }),
  );
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 7 }));
  assert.equal(
    lastSnap(snaps).dirtyFromPage,
    7,
    "dirty(D=7) above highestShipout(1) ⇒ frontier at D",
  );
  client.destroy();
}

// Case 4: a later, larger segment cleans the dirty range.
// dirty(D=1) with T=3 ⇒ frontier 4. A follow-up segment with T=5
// covers pages up to 5 ⇒ frontier advances to 6.
{
  const { client, ws, snaps } = newClient();
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 3,
    }),
  );
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 1 }));
  assert.equal(lastSnap(snaps).dirtyFromPage, 4);
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 5,
    }),
  );
  assert.equal(
    lastSnap(snaps).dirtyFromPage,
    6,
    "wider segment advances the dirty frontier past T",
  );
  client.destroy();
}

// Case 5: a new (narrower) dirty event re-introduces a lower
// frontier. Round 1: D=5, T=3 ⇒ frontier 5. Round 2: D=2, T=3 ⇒
// candidate = max(2, 4) = 4 ⇒ frontier = min(5, 4) = 4.
{
  const { client, ws, snaps } = newClient();
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 3,
    }),
  );
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 5 }));
  assert.equal(lastSnap(snaps).dirtyFromPage, 5);
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      shipoutPage: 3,
    }),
  );
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 2 }));
  assert.equal(
    lastSnap(snaps).dirtyFromPage,
    4,
    "narrower D after wider keeps the lower (clamped to first unshipped)",
  );
  client.destroy();
}

// Case 6: segment without shipoutPage (e.g. FixtureCompiler path)
// must not advance the dirty frontier — the compiler can't tell us
// which pages were re-typeset.
{
  const { client, ws, snaps } = newClient();
  ws.dispatchMessage(encodeControl({ type: "dirty-page", page: 1 }));
  assert.equal(lastSnap(snaps).dirtyFromPage, 1);
  ws.dispatchMessage(
    encodePdfSegment({
      totalLength: bytes.length,
      offset: 0,
      bytes,
      // shipoutPage omitted on purpose
    }),
  );
  assert.equal(
    lastSnap(snaps).dirtyFromPage,
    1,
    "segment without shipoutPage must not move the frontier",
  );
  client.destroy();
}

console.log("wsClientDirtyPage: ok");
