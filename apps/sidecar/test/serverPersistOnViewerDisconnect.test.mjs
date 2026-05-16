// Pins the M20.3 GT-9 data-loss bug fix (iter 345). When a viewer
// disconnects with Yjs ops in the doc that haven't yet been
// persisted (because the next debounce-fired compile hasn't run),
// the sidecar must still flush those ops to the blob store before
// the in-memory Y.Doc dies.
//
// Repro (matches the prod failure shape):
//   1. Client connects, hydrates against a seeded blob.
//   2. Client sends an edit via Yjs.
//   3. Client closes the WS within the 100 ms debounce window so the
//      coalescer's pending compile never fires.
//   4. Without the fix: `coalescer.cancel()` clears the timer and no
//      `runCompile` (hence no `maybePersist`) runs. Blob stays at
//      the seeded value. The trailing edit is lost on the next cold
//      boot.
//   5. With the fix: the WS-close handler kicks
//      `persistence.maybePersist()` before the cancel, so the new
//      doc state lands in the blob.
//
// We don't rely on any timing slack inside the fix; we just poll
// the blob for the expected content. The poll deadline is generous
// (5 s); under the fix the PUT lands well within that window.

import assert from "node:assert/strict";

import * as Y from "yjs";

import {
  MAIN_DOC_NAME,
  encodeDocUpdate,
} from "../../../packages/protocol/src/index.ts";
import {
  bootClient,
  makeBlobStore,
  seedMainTex,
  startServer,
} from "./lib.mjs";

const { blobStore } = makeBlobStore("persist-on-viewer-disconnect");
const projectId = "viewer-disconnect-flush";
const initial =
  "\\documentclass{article}\\begin{document}seed\\end{document}";
await seedMainTex(blobStore, projectId, initial);

const app = await startServer({ blobStore });

const { ws, frames, text } = await bootClient(app, projectId);

// Wait for hydration so the client's Y.Doc has the seeded state.
const deadline = Date.now() + 5_000;
while (Date.now() < deadline && text.toString() !== initial) {
  await new Promise((r) => setTimeout(r, 25));
}
assert.equal(
  text.toString(),
  initial,
  "client must hydrate to the seeded text before driving an edit",
);

// Drive a destructive Yjs edit that completely replaces the body.
// Send the update, then close the WS aggressively — within the
// debounce window, so a buggy server has no chance to flush via the
// normal compile path. The fix must flush on the WS close.
const target =
  "\\documentclass{article}\\begin{document}seed-PERSIST-ON-CLOSE-SENTINEL\\end{document}";
const before = Y.encodeStateVector(text.doc);
text.doc.transact(() => {
  text.delete(0, text.length);
  text.insert(0, target);
});
ws.send(encodeDocUpdate(Y.encodeStateAsUpdate(text.doc, before)));

// Close immediately. We DO NOT wait for any pdf-segment or
// compile-status frame; the whole point of the test is the case
// where the debounce timer is killed before the compile fires.
ws.close();
await new Promise((r) => ws.once("close", r));

// Poll the blob for the edited content. Without the fix this never
// arrives — the server simply cancelled the coalescer and went idle.
const blobDeadline = Date.now() + 5_000;
const mainKey = `projects/${projectId}/files/main.tex`;
let lastSeen = "(unread)";
while (Date.now() < blobDeadline) {
  const bytes = await blobStore.get(mainKey);
  if (bytes) {
    lastSeen = new TextDecoder().decode(bytes);
    if (lastSeen === target) break;
  }
  await new Promise((r) => setTimeout(r, 25));
}
assert.equal(
  lastSeen,
  target,
  `blob must reflect the edit applied immediately before WS close; ` +
    `seen=${JSON.stringify(lastSeen.slice(0, 120))} frames=${JSON.stringify(
      frames.map((f) => f.kind),
    )}`,
);

await app.close();

console.log("sidecar persist-on-viewer-disconnect: OK");
