// Unit test for WsClient.onDebugEvent + debugEventToToast — the
// debug-mode protocol fan-out slice of M9.editor-ux. Verifies one
// event fires per observed frame and that the toast mapping
// covers all six event kinds with the expected category and
// aggregateKey shape.

import assert from "node:assert/strict";
import * as Y from "yjs";

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
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  dispatchMessage(bytes) {
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.buffer.slice(0) }),
    );
  }
}
globalThis.WebSocket = FakeWebSocket;

const { WsClient } = await import("../src/lib/wsClient.ts");
const { debugEventToToast } = await import("../src/lib/debugToasts.ts");
const {
  encodeControl,
  encodeDocUpdate,
  encodePdfSegment,
  MAIN_DOC_NAME,
} = await import("@tex-center/protocol");

function newClient() {
  FakeWebSocket.instances = [];
  const events = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onDebugEvent: (e) => events.push(e),
  });
  const sock = FakeWebSocket.instances.at(-1);
  return { c, sock, events };
}

// Case 1: pdf-segment frame produces a debug event with the
// segment length. shipoutPage omitted ⇒ wire sentinel 0 ⇒ debug
// event omits the field.
{
  const { c, sock, events } = newClient();
  sock.dispatchMessage(
    encodePdfSegment({
      totalLength: 4,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3, 4]),
    }),
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "pdf-segment", bytes: 4 });
  c.destroy();
}

// Case 1b (M22.4b): pdf-segment frame stamped with shipoutPage
// surfaces it on the debug event.
{
  const { c, sock, events } = newClient();
  sock.dispatchMessage(
    encodePdfSegment({
      totalLength: 4,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3, 4]),
      shipoutPage: 5,
    }),
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "pdf-segment",
    bytes: 4,
    shipoutPage: 5,
  });
  c.destroy();
}

// Case 2: compile-status fires for every state, including non-
// error states (no detail required), and forwards detail when
// present.
{
  const { c, sock, events } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "running" }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "idle" }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "error", detail: "boom" }),
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "compile-status");
  assert.equal(events[0].state, "running");
  assert.equal(events[2].state, "error");
  assert.equal(events[2].detail, "boom");
  c.destroy();
}

// Case 3: file-list and file-op-error each emit one event per
// frame; back-to-back duplicates each surface.
{
  const { c, sock, events } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "file-list", files: [MAIN_DOC_NAME, "a.tex"] }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "file-op-error", reason: "duplicate" }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "file-op-error", reason: "duplicate" }),
  );
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { kind: "file-list", count: 2 });
  assert.deepEqual(events[1], { kind: "file-op-error", reason: "duplicate" });
  assert.deepEqual(events[2], { kind: "file-op-error", reason: "duplicate" });
  c.destroy();
}

// Case 4: hello control frame fires a debug event with the
// protocol number.
{
  const { c, sock, events } = newClient();
  sock.dispatchMessage(encodeControl({ type: "hello", protocol: 7 }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "hello", protocol: 7 });
  c.destroy();
}

// Case 5: outgoing Yjs ops fire `outgoing-doc-update` only when
// the socket is open (writes that would no-op should not emit).
{
  const { c, sock, events } = newClient();
  // Before open: local Y.Doc edit does not fire.
  c.text.insert(0, "hi");
  assert.equal(
    events.filter((e) => e.kind === "outgoing-doc-update").length,
    0,
  );
  // After open: a fresh edit fires once with the byte count
  // matching what reached the socket.
  sock.open();
  events.length = 0;
  c.text.insert(2, " there");
  const outgoing = events.filter((e) => e.kind === "outgoing-doc-update");
  assert.equal(outgoing.length, 1);
  assert.ok(outgoing[0].bytes > 0);
  // Sanity: the socket actually got a frame.
  assert.ok(sock.sent.length >= 1);
  c.destroy();
}

// Case 6: doc-update applied from the server is NOT reported as
// outgoing — origin === client is filtered out.
{
  const { c, sock, events } = newClient();
  sock.open();
  const sibling = new Y.Doc();
  sibling.getText(MAIN_DOC_NAME).insert(0, "x");
  const update = Y.encodeStateAsUpdate(sibling);
  sibling.destroy();
  events.length = 0;
  sock.dispatchMessage(encodeDocUpdate(update));
  const outgoing = events.filter((e) => e.kind === "outgoing-doc-update");
  assert.equal(outgoing.length, 0);
  c.destroy();
}

// Case 7: debugEventToToast covers all event kinds (incoming +
// outgoing) with the expected category and a non-empty
// aggregateKey.
{
  const cases = [
    { kind: "pdf-segment", bytes: 100 },
    { kind: "pdf-segment", bytes: 100, shipoutPage: 2 },
    { kind: "outgoing-doc-update", bytes: 50 },
    { kind: "compile-status", state: "running" },
    { kind: "compile-status", state: "error", detail: "boom" },
    { kind: "file-list", count: 3 },
    { kind: "hello", protocol: 1 },
    { kind: "file-op-error", reason: "duplicate" },
    { kind: "outgoing-viewing-page", page: 2 },
    { kind: "outgoing-create-file", name: "a.tex" },
    { kind: "outgoing-upload-file", name: "a.tex", bytes: 42 },
    { kind: "outgoing-delete-file", name: "a.tex" },
    { kind: "outgoing-rename-file", oldName: "a.tex", newName: "b.tex" },
  ];
  const expectedCategories = [
    "debug-blue",
    "debug-blue",
    "debug-green",
    "debug-orange",
    "debug-orange",
    "debug-grey",
    "debug-grey",
    "debug-red",
    "debug-green",
    "debug-green",
    "debug-green",
    "debug-green",
    "debug-green",
  ];
  for (let i = 0; i < cases.length; i++) {
    const out = debugEventToToast(cases[i]);
    assert.equal(
      out.category,
      expectedCategories[i],
      `case ${i} category mismatch`,
    );
    assert.ok(out.text.length > 0, `case ${i} empty text`);
    assert.ok(
      typeof out.aggregateKey === "string" && out.aggregateKey.length > 0,
      `case ${i} missing aggregateKey`,
    );
  }
  // The same compile-status state shares a key (coalesces); a
  // different state gets a distinct key (running vs error
  // surface separately).
  const a = debugEventToToast({ kind: "compile-status", state: "running" });
  const b = debugEventToToast({ kind: "compile-status", state: "idle" });
  const c2 = debugEventToToast({ kind: "compile-status", state: "running" });
  assert.equal(a.aggregateKey, c2.aggregateKey);
  assert.notEqual(a.aggregateKey, b.aggregateKey);
  // pdf-segment and yjs-op share a single key per kind (burst
  // coalescing); file-op-error keyed by reason. M22.4b + iter-374
  // iter-B′: an unstamped segment is `<bytes> bytes`; a stamped
  // `shipoutPage===1` is `[1.out] <bytes> bytes`; a stamped
  // `shipoutPage>1` is `[1..N.out] <bytes> bytes` — the range form
  // surfaces that the sidecar concatenates chunks `1..N.out` per
  // round (per `assembleSegment(maxShipout)`). Both kinds share the
  // same aggregateKey so a burst still coalesces.
  const seg1 = debugEventToToast({ kind: "pdf-segment", bytes: 1 });
  const seg2 = debugEventToToast({ kind: "pdf-segment", bytes: 99 });
  assert.equal(seg1.aggregateKey, seg2.aggregateKey);
  assert.equal(seg1.text, "1 bytes");
  assert.equal(seg2.text, "99 bytes");
  const segPage1 = debugEventToToast({
    kind: "pdf-segment",
    bytes: 512,
    shipoutPage: 1,
  });
  assert.equal(segPage1.text, "[1.out] 512 bytes");
  assert.equal(segPage1.aggregateKey, seg1.aggregateKey);
  const seg3 = debugEventToToast({
    kind: "pdf-segment",
    bytes: 1024,
    shipoutPage: 4,
  });
  assert.equal(seg3.text, "[1..4.out] 1024 bytes");
  assert.equal(seg3.aggregateKey, seg1.aggregateKey);
  const e1 = debugEventToToast({
    kind: "file-op-error",
    reason: "duplicate",
  });
  const e2 = debugEventToToast({
    kind: "file-op-error",
    reason: "unknown name",
  });
  assert.notEqual(e1.aggregateKey, e2.aggregateKey);
}

// Case 9: outgoing control sends (viewing-page / create-file /
// upload-file / delete-file / rename-file) each emit a single
// debug event after the socket is open, with the per-event shape
// matching the wire payload. Pre-open sends are silent (the
// underlying frame would no-op on the wire).
{
  const { c, sock, events } = newClient();
  // Pre-open: each method is called but produces no debug event.
  c.setViewingPage(1);
  c.createFile("a.tex");
  c.uploadFile("a.tex", "hello");
  c.deleteFile("a.tex");
  c.renameFile("a.tex", "b.tex");
  assert.equal(
    events.filter((e) => e.kind.startsWith("outgoing-")).length,
    0,
  );
  // After open: each fires exactly one event.
  sock.open();
  events.length = 0;
  c.setViewingPage(3);
  c.createFile("c.tex");
  c.uploadFile("d.tex", "abc");
  c.deleteFile("e.tex");
  c.renameFile("f.tex", "g.tex");
  assert.equal(events.length, 5);
  assert.deepEqual(events[0], { kind: "outgoing-viewing-page", page: 3 });
  assert.deepEqual(events[1], { kind: "outgoing-create-file", name: "c.tex" });
  assert.deepEqual(events[2], {
    kind: "outgoing-upload-file",
    name: "d.tex",
    bytes: 3,
  });
  assert.deepEqual(events[3], { kind: "outgoing-delete-file", name: "e.tex" });
  assert.deepEqual(events[4], {
    kind: "outgoing-rename-file",
    oldName: "f.tex",
    newName: "g.tex",
  });
  c.destroy();
}

// Case 8: omitting onDebugEvent must not throw when frames
// arrive.
{
  FakeWebSocket.instances = [];
  const c = new WsClient({ url: "ws://localhost/x" });
  const sock = FakeWebSocket.instances.at(-1);
  sock.dispatchMessage(encodeControl({ type: "hello", protocol: 1 }));
  sock.dispatchMessage(
    encodePdfSegment({
      totalLength: 1,
      offset: 0,
      bytes: new Uint8Array([1]),
    }),
  );
  c.destroy();
}

console.log("wsClient debug events: OK");
