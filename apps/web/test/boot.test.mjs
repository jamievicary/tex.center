// Unit test for the custom Node entry's `boot()` function.
// Boots an ephemeral server with a fake adapter-node handler and a
// stub sidecar upstream, asserts that:
//   1. Plain HTTP requests reach the handler.
//   2. /ws/project/<id> Upgrade requests are proxied to upstream.
//   3. Unknown Upgrade paths get a 404 from the proxy.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { boot, parsePort } from "../src/lib/server/boot.ts";

// ---- parsePort ----

assert.equal(parsePort(undefined, 3000), 3000);
assert.equal(parsePort("", 3000), 3000);
assert.equal(parsePort("8080", 3000), 8080);
assert.equal(parsePort("0", 3000), 0);
assert.equal(parsePort("65535", 3000), 65535);
assert.throws(() => parsePort("nope", 3000), /PORT/);
assert.throws(() => parsePort("-1", 3000), /PORT/);
assert.throws(() => parsePort("65536", 3000), /PORT/);

// ---- integration ----

// Stub upstream sidecar that echoes the request line back to its peer.
const upstreamServer = net.createServer((sock) => {
  const chunks = [];
  sock.on("data", (b) => {
    chunks.push(b);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.includes("\r\n\r\n")) {
      sock.write("UPSTREAM-ACK\n");
    }
  });
});
await new Promise((res) => upstreamServer.listen(0, "127.0.0.1", res));
const upstreamPort = upstreamServer.address().port;

// Fake adapter-node handler: respond with the request URL so the
// test can verify it ran.
const handler = (req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end(`handled:${req.url}`);
};

// `onWsProxyEvent` is forwarded to the WS proxy so production
// (`server.ts`) can log structured lifecycle events to stdout.
// Captured here to lock the plumbing.
const proxyEvents = [];
const { server, detachProxy } = boot({
  handler,
  host: "127.0.0.1",
  port: 0,
  env: { SIDECAR_HOST: "127.0.0.1", SIDECAR_PORT: String(upstreamPort) },
  onWsProxyEvent: (e) => proxyEvents.push(e),
});

await new Promise((res) => server.once("listening", res));
const listenPort = server.address().port;

// (1) Plain HTTP request reaches the handler.
{
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: listenPort, path: "/anything", method: "GET" },
      (res) => {
        const bufs = [];
        res.on("data", (b) => bufs.push(b));
        res.on("end", () => resolve(Buffer.concat(bufs).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "handled:/anything");
}

// (2) Valid Upgrade gets proxied: client receives the upstream's ACK.
{
  const sock = net.connect(listenPort, "127.0.0.1");
  await new Promise((res) => sock.once("connect", res));
  sock.write(
    `GET /ws/project/proj1 HTTP/1.1\r\n` +
      `Host: localhost:${listenPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  );
  const got = await new Promise((resolve, reject) => {
    const chunks = [];
    const t = setTimeout(() => reject(new Error("upstream ack timeout")), 2000);
    sock.on("data", (b) => {
      chunks.push(b);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("UPSTREAM-ACK")) {
        clearTimeout(t);
        resolve(text);
      }
    });
  });
  assert.match(got, /UPSTREAM-ACK/);
  sock.destroy();
}

// (3) Unknown Upgrade path → 404 from the proxy.
{
  const sock = net.connect(listenPort, "127.0.0.1");
  await new Promise((res) => sock.once("connect", res));
  sock.write(
    `GET /nope HTTP/1.1\r\n` +
      `Host: localhost:${listenPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: x\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  );
  const got = await new Promise((resolve, reject) => {
    const chunks = [];
    const t = setTimeout(() => reject(new Error("404 timeout")), 2000);
    sock.on("data", (b) => {
      chunks.push(b);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("404")) {
        clearTimeout(t);
        resolve(text);
      }
    });
  });
  assert.match(got, /HTTP\/1\.1 404/);
  sock.destroy();
}

// (4) onWsProxyEvent received events from the two upgrade attempts
// above. The valid /ws/project/proj1 upgrade emits at minimum
// `upstream-connect` and `upstream-connected`; the /nope upgrade
// emits `no-match`. Lock the wiring, not the exact event sequence.
{
  const kinds = new Set(proxyEvents.map((e) => e.kind));
  assert.ok(kinds.has("no-match"), `expected no-match, got ${[...kinds].join(",")}`);
  assert.ok(
    kinds.has("upstream-connect") || kinds.has("upstream-connected"),
    `expected upstream-connect(ed), got ${[...kinds].join(",")}`,
  );
}

// Teardown.
detachProxy();
await new Promise((res) => server.close(res));
await new Promise((res) => upstreamServer.close(res));

console.log("boot ok");
