// Unit test for WsClient's narrow event callbacks
// (`onFileOpError`, `onCompileError`). These power the user-facing
// red toasts in the editor (M9.editor-ux toast-consumers slice).
//
// The callbacks must fire on every relevant frame — including
// back-to-back identical errors — because the toast store
// dedups via `aggregateKey`, not via wsClient state transitions.

import assert from "node:assert/strict";
import * as Y from "yjs";

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
const { encodeControl, encodeDocUpdate, encodePdfSegment, MAIN_DOC_NAME } =
  await import("@tex-center/protocol");

function newClient(opts = {}) {
  FakeWebSocket.instances = [];
  const fileOpErrors = [];
  const compileErrors = [];
  const c = new WsClient({
    url: "ws://localhost/x",
    onFileOpError: (r) => fileOpErrors.push(r),
    onCompileError: (d) => compileErrors.push(d),
    ...opts,
  });
  const sock = FakeWebSocket.instances.at(-1);
  return { c, sock, fileOpErrors, compileErrors };
}

// Case 1: file-op-error frame fires onFileOpError with the reason.
{
  const { c, sock, fileOpErrors } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "file-op-error", reason: "duplicate name" }),
  );
  assert.deepEqual(fileOpErrors, ["duplicate name"]);
  c.destroy();
}

// Case 2: back-to-back identical file-op-error frames each fire.
// The toast store will dedup via aggregateKey; the wire-level
// callback must not swallow repeats.
{
  const { c, sock, fileOpErrors } = newClient();
  for (let i = 0; i < 3; i++) {
    sock.dispatchMessage(
      encodeControl({ type: "file-op-error", reason: "duplicate name" }),
    );
  }
  assert.equal(fileOpErrors.length, 3);
  assert.ok(fileOpErrors.every((r) => r === "duplicate name"));
  c.destroy();
}

// Case 3: compile-status state=error fires onCompileError with
// the detail.
{
  const { c, sock, compileErrors } = newClient();
  sock.dispatchMessage(
    encodeControl({
      type: "compile-status",
      state: "error",
      detail: "Missing \\begin{document}",
    }),
  );
  assert.deepEqual(compileErrors, ["Missing \\begin{document}"]);
  c.destroy();
}

// Case 4: compile-status state=error with no detail falls back to
// the literal "compile error" string.
{
  const { c, sock, compileErrors } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "error" }),
  );
  assert.deepEqual(compileErrors, ["compile error"]);
  c.destroy();
}

// Case 5: non-error compile-status frames do NOT fire
// onCompileError. Idle/running churn must not spam toasts.
{
  const { c, sock, compileErrors } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "running" }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "idle" }),
  );
  assert.deepEqual(compileErrors, []);
  c.destroy();
}

// Case 6: unrelated frame types (file-list, doc-update,
// pdf-segment) do not fire either callback.
{
  const { c, sock, fileOpErrors, compileErrors } = newClient();
  sock.dispatchMessage(
    encodeControl({ type: "file-list", files: [MAIN_DOC_NAME] }),
  );
  const sibling = new Y.Doc();
  sibling.getText(MAIN_DOC_NAME).insert(0, "x");
  const update = Y.encodeStateAsUpdate(sibling);
  sibling.destroy();
  sock.dispatchMessage(encodeDocUpdate(update));
  sock.dispatchMessage(
    encodePdfSegment({ totalLength: 1, offset: 0, bytes: new Uint8Array([0]) }),
  );
  assert.deepEqual(fileOpErrors, []);
  assert.deepEqual(compileErrors, []);
  c.destroy();
}

// Case 7: omitting the callbacks must not throw when the
// corresponding frames arrive.
{
  FakeWebSocket.instances = [];
  const c = new WsClient({ url: "ws://localhost/x" });
  const sock = FakeWebSocket.instances.at(-1);
  sock.dispatchMessage(
    encodeControl({ type: "file-op-error", reason: "x" }),
  );
  sock.dispatchMessage(
    encodeControl({ type: "compile-status", state: "error", detail: "y" }),
  );
  c.destroy();
}

console.log("wsClient toast events: OK");
