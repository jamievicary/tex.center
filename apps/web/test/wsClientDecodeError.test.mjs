// Iter 356 — when an inbound binary frame fails `decodeFrame`,
// WsClient must surface the error via `console.error` so the
// iter-355 Playwright fixture (`tests_gold/playwright/fixtures/
// authedPage.ts`) can capture and dump it in the gold transcript.
// Pins the observability path that flushed the iter-354 stale-
// per-project-image symptom into view this iteration.

import assert from "node:assert/strict";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  url;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(frame) {
    this.sent.push(frame);
  }
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

// A truncated pdf-segment body (tag + 12 zero bytes — matches the
// pre-iter-317 13-byte header shape, body.length=12 < 16 required
// by the new decoder) reliably throws "pdf-segment payload
// truncated" out of `decodeFrame`.
const truncated = new Uint8Array(13);
truncated[0] = 0x20; // TAG_PDF_SEGMENT

const errors = [];
const origError = console.error;
console.error = (...args) => {
  errors.push(args.map(String).join(" "));
};

try {
  FakeWebSocket.instances = [];
  const c = new WsClient({ url: "ws://localhost/x" });
  const sock = FakeWebSocket.instances.at(-1);
  sock.dispatchMessage(truncated);
  // _lastError is surfaced on the snapshot too — assert both paths.
  assert.match(c.snapshot().lastError ?? "", /pdf-segment/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[WsClient\] decodeFrame failed:/);
  c.destroy();
} finally {
  console.error = origError;
}

console.log("ok wsClientDecodeError");
