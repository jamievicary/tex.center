// `/ws/project/:projectId` rejects malformed project ids at the
// edge with a `1008` policy-violation close, so neither the
// `ProjectWorkspace` validator nor `getProject`'s lazy seeding
// ever observes a bad id. A well-formed id still connects.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { buildServer } from "../src/server.ts";

const scratchRoot = mkdtempSync(join(tmpdir(), "sidecar-projid-test-"));
const app = await buildServer({ logger: false, scratchRoot });
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("listen() returned no address info");
}
const port = address.port;

async function expectReject(pathSuffix) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${pathSuffix}`);
  ws.binaryType = "arraybuffer";
  const close = await new Promise((resolve, reject) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on("error", reject);
  });
  assert.equal(close.code, 1008, `expected 1008 for ${pathSuffix}`);
  assert.match(close.reason, /invalid projectId/);
}

await expectReject("bad.id");
await expectReject(encodeURIComponent("has space"));
await expectReject("trailing!");

// Sanity-check the valid path still opens and stays open until we close it.
{
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/good-id_123`);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code) =>
      reject(new Error(`unexpected close for good id, code=${code}`)),
    );
  });
  ws.close();
}

await app.close();
console.log("serverProjectIdValidation.test.mjs OK");
