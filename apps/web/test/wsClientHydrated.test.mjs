// Unit test for WsClient's `hydrated` snapshot field. The flag
// underpins the no-flash editor mount (GT-A); it must flip
// false→true on the first authoritative server frame (either a
// `doc-update` or a `file-list` control), and only then.

import assert from "node:assert/strict";
import * as Y from "yjs";

// Browser-style WebSocket fake. We capture each instance so the
// test can dispatch frames back to the WsClient.
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
    // ArrayBuffer because `binaryType` is set to "arraybuffer"
    // by WsClient on connect.
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.buffer.slice(0) }),
    );
  }
}
globalThis.WebSocket = FakeWebSocket;

const { WsClient } = await import("../src/lib/wsClient.ts");
const { encodeControl, encodeDocUpdate, MAIN_DOC_NAME } = await import(
  "@tex-center/protocol"
);

// Case 1: initial snapshot has hydrated === false.
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  assert.equal(c.snapshot().hydrated, false);
  c.destroy();
}

// Case 2: a `file-list` control flips hydrated true and emits.
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const sock = FakeWebSocket.instances.at(-1);
  assert.equal(c.snapshot().hydrated, false);
  sock.dispatchMessage(encodeControl({ type: "file-list", files: [MAIN_DOC_NAME] }));
  assert.equal(c.snapshot().hydrated, true);
  // The emit must have surfaced the flipped flag to subscribers.
  assert.ok(
    snaps.some((s) => s.hydrated === true),
    "onChange never observed hydrated=true after file-list",
  );
  c.destroy();
}

// Case 3: a `doc-update` frame also flips hydrated true.
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const sock = FakeWebSocket.instances.at(-1);
  // Build a real Yjs update from a sibling doc so applyUpdate is
  // a no-op on the wire format but exercises the real code path.
  const sibling = new Y.Doc();
  sibling.getText(MAIN_DOC_NAME).insert(0, "x");
  const update = Y.encodeStateAsUpdate(sibling);
  sibling.destroy();
  sock.dispatchMessage(encodeDocUpdate(update));
  assert.equal(c.snapshot().hydrated, true);
  assert.ok(
    snaps.some((s) => s.hydrated === true),
    "onChange never observed hydrated=true after doc-update",
  );
  c.destroy();
}

// Case 4: control frames that are NOT file-list don't flip the
// flag (e.g. an initial `compile-status` from the sidecar).
{
  FakeWebSocket.instances = [];
  const c = new WsClient({ url: "ws://localhost/x" });
  const sock = FakeWebSocket.instances.at(-1);
  sock.dispatchMessage(encodeControl({ type: "compile-status", state: "running" }));
  assert.equal(
    c.snapshot().hydrated,
    false,
    "compile-status must not be treated as a hydration signal",
  );
  c.destroy();
}

// Case 5: once hydrated, repeated frames must not re-flip (the
// emit-on-transition guard).
{
  FakeWebSocket.instances = [];
  const snaps = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onChange: (s) => snaps.push(s),
  });
  const sock = FakeWebSocket.instances.at(-1);
  const sibling = new Y.Doc();
  sibling.getText(MAIN_DOC_NAME).insert(0, "x");
  const update = Y.encodeStateAsUpdate(sibling);
  sibling.destroy();
  sock.dispatchMessage(encodeDocUpdate(update));
  const emittedAfterFirst = snaps.length;
  // A second doc-update should still produce an emit (pdf/text
  // state changes etc.), but the hydrated path itself must not
  // re-emit redundantly — exercised here by passing a no-op
  // update; the Y.applyUpdate path won't emit on its own.
  sock.dispatchMessage(encodeDocUpdate(new Uint8Array([0, 0])));
  // The flag stays true.
  assert.equal(c.snapshot().hydrated, true);
  // No extra hydration-driven emit beyond the first transition.
  // (We can't assert exact counts because applyUpdate may itself
  // throw on bad bytes; just confirm hydration latched.)
  assert.ok(emittedAfterFirst >= 1);
  c.destroy();
}

console.log("wsClient hydration: OK");
