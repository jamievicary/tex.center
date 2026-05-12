// Unit + integration tests for the control-plane WS proxy.
//
// Pure-logic helpers (`matchWsProjectPath`, `resolveSidecarUpstream`,
// `renderForwardedHeaders`) are exercised first. Then a real
// http.Server + stub upstream net.Server demonstrate that an HTTP
// Upgrade request on `/ws/project/<id>` is forwarded byte-for-byte
// and that bytes flow bidirectionally afterwards.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import {
  DEFAULT_SIDECAR_HOST,
  DEFAULT_SIDECAR_PORT,
  attachWsProxy,
  matchWsProjectPath,
  renderForwardedHeaders,
  resolveSidecarUpstream,
} from "../src/lib/server/wsProxy.ts";

// ---- pure-logic ----

assert.equal(matchWsProjectPath("/ws/project/abc123"), "abc123");
assert.equal(matchWsProjectPath("/ws/project/a_b-C"), "a_b-C");
assert.equal(matchWsProjectPath("/ws/project/"), null);
assert.equal(matchWsProjectPath("/ws/project"), null);
assert.equal(matchWsProjectPath("/ws/project/a/b"), null);
assert.equal(matchWsProjectPath("/ws/project/abc/"), null);
assert.equal(matchWsProjectPath("/ws/project/has space"), null);
assert.equal(matchWsProjectPath("/ws/project/has.dot"), null);
assert.equal(matchWsProjectPath("/other/path"), null);
assert.equal(matchWsProjectPath("/"), null);

const defaultUp = resolveSidecarUpstream({});
assert.equal(defaultUp.host, DEFAULT_SIDECAR_HOST);
assert.equal(defaultUp.port, DEFAULT_SIDECAR_PORT);

assert.deepEqual(
  resolveSidecarUpstream({ SIDECAR_HOST: "h", SIDECAR_PORT: "9999" }),
  { host: "h", port: 9999 },
);

assert.throws(
  () => resolveSidecarUpstream({ SIDECAR_PORT: "not-a-number" }),
  /SIDECAR_PORT must be a positive integer/,
);
assert.throws(
  () => resolveSidecarUpstream({ SIDECAR_PORT: "0" }),
  /SIDECAR_PORT/,
);
assert.throws(
  () => resolveSidecarUpstream({ SIDECAR_PORT: "70000" }),
  /SIDECAR_PORT/,
);

// renderForwardedHeaders rewrites Host:, preserves duplicates+casing.
const hdr = renderForwardedHeaders(
  [
    "Host", "tex.center",
    "Upgrade", "websocket",
    "Connection", "Upgrade",
    "Sec-WebSocket-Key", "abc==",
    "Sec-WebSocket-Version", "13",
    "Cookie", "tc_session=foo",
  ],
  { host: "upstream.internal", port: 3001 },
);
assert.match(hdr, /^Host: upstream\.internal:3001\r\n/);
assert.match(hdr, /Upgrade: websocket\r\n/);
assert.match(hdr, /Sec-WebSocket-Key: abc==\r\n/);
assert.match(hdr, /Cookie: tc_session=foo\r\n/);

// No host header → one is added.
const hdr2 = renderForwardedHeaders(
  ["Upgrade", "websocket"],
  { host: "u", port: 80 },
);
assert.match(hdr2, /Host: u\r\n/);
assert.doesNotMatch(hdr2, /:80/);

// Multiple Host headers → only one kept.
const hdr3 = renderForwardedHeaders(
  ["Host", "a", "Host", "b"],
  { host: "u", port: 443 },
);
const hostCount = hdr3.match(/Host:/g)?.length ?? 0;
assert.equal(hostCount, 1);

// ---- integration: real http.Server + stub upstream ----

const STUB_GREETING = "HELLO\n";

const upstreamConnections = [];
const upstreamServer = net.createServer((sock) => {
  const recvChunks = [];
  upstreamConnections.push({ socket: sock, recv: recvChunks });
  sock.on("data", (b) => {
    recvChunks.push(b);
    const text = Buffer.concat(recvChunks).toString("utf8");
    // Once we see the request terminator, send a stub greeting so
    // the client knows bytes flow upstream → downstream.
    if (text.includes("\r\n\r\n") && !sock.__greeted) {
      sock.__greeted = true;
      sock.write(STUB_GREETING);
    }
  });
});
await new Promise((res) => upstreamServer.listen(0, "127.0.0.1", res));
const upstreamPort = upstreamServer.address().port;

const httpServer = http.createServer();
const events = [];
const detach = attachWsProxy(httpServer, {
  upstream: { host: "127.0.0.1", port: upstreamPort },
  connectTimeoutMs: 2000,
  onEvent: (e) => events.push(e),
});
await new Promise((res) => httpServer.listen(0, "127.0.0.1", res));
const proxyPort = httpServer.address().port;

async function rawUpgrade(path) {
  const sock = net.connect(proxyPort, "127.0.0.1");
  await new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });
  sock.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: localhost:${proxyPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Cookie: tc_session=stub\r\n` +
      `\r\n`,
  );
  return sock;
}

async function readUntil(sock, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      sock.off("data", onData);
      sock.off("close", onClose);
      reject(new Error("readUntil timeout"));
    }, timeoutMs);
    const finish = (val) => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("close", onClose);
      resolve(val);
    };
    const onData = (b) => {
      chunks.push(b);
      const buf = Buffer.concat(chunks);
      if (predicate(buf)) finish(buf);
    };
    const onClose = () => {
      const buf = Buffer.concat(chunks);
      if (predicate(buf)) finish(buf);
      else {
        clearTimeout(timer);
        reject(new Error("socket closed before predicate"));
      }
    };
    sock.on("data", onData);
    sock.on("close", onClose);
  });
}

// Case 1: valid path → bytes pipe through both ways.
{
  const sock = await rawUpgrade("/ws/project/abc123");
  // Wait for the stub greeting forwarded back from upstream.
  const got = await readUntil(sock, (b) =>
    b.toString("utf8").includes("HELLO"),
  );
  assert.ok(got.toString("utf8").includes("HELLO"));

  // Now send client→upstream bytes and assert upstream received them.
  sock.write("ping-from-client");
  await new Promise((res) => setTimeout(res, 50));
  const conn = upstreamConnections[upstreamConnections.length - 1];
  const text = Buffer.concat(conn.recv).toString("utf8");
  assert.ok(text.includes("ping-from-client"), `client→upstream not seen: ${text}`);
  // Upstream saw the rewritten Host header.
  assert.ok(
    text.includes(`Host: 127.0.0.1:${upstreamPort}\r\n`),
    `Host not rewritten: ${text}`,
  );
  // And the cookie passed through.
  assert.ok(text.includes("Cookie: tc_session=stub"), "cookie not forwarded");
  sock.destroy();
}

// Case 2: unknown path → proxy responds 404 and closes.
{
  const sock = await rawUpgrade("/not/our/route");
  const got = await readUntil(sock, (b) =>
    b.toString("utf8").includes("404"),
  );
  assert.match(got.toString("utf8"), /HTTP\/1\.1 404/);
  sock.destroy();
}

// Case 3: invalid projectId → 404.
{
  const sock = await rawUpgrade("/ws/project/has%20space");
  // %20 is decoded? No — pathname keeps it encoded; our regex
  // rejects "%" so it's a no-match.
  const got = await readUntil(sock, (b) =>
    b.toString("utf8").includes("404"),
  );
  assert.match(got.toString("utf8"), /HTTP\/1\.1 404/);
  sock.destroy();
}

// Case 4: upstream connect error → client socket closed without
// hanging. Use a known-closed port.
{
  const closedServer = net.createServer();
  await new Promise((res) => closedServer.listen(0, "127.0.0.1", res));
  const closedPort = closedServer.address().port;
  await new Promise((res) => closedServer.close(res));

  const localHttp = http.createServer();
  attachWsProxy(localHttp, {
    upstream: { host: "127.0.0.1", port: closedPort },
    connectTimeoutMs: 500,
  });
  await new Promise((res) => localHttp.listen(0, "127.0.0.1", res));
  const port = localHttp.address().port;

  const sock = net.connect(port, "127.0.0.1");
  await new Promise((res) => sock.once("connect", res));
  sock.write(
    `GET /ws/project/abc HTTP/1.1\r\n` +
      `Host: localhost\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: x\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  );
  await new Promise((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error("client socket not closed")),
      2000,
    );
    sock.once("close", () => {
      clearTimeout(timer);
      res();
    });
  });
  await new Promise((res) => localHttp.close(res));
}

// Teardown.
detach();
await new Promise((res) => httpServer.close(res));
await new Promise((res) => upstreamServer.close(res));

// Sanity: events recorded for the happy path.
assert.ok(
  events.some((e) => e.kind === "upstream-connected"),
  `expected upstream-connected event: ${JSON.stringify(events)}`,
);
assert.ok(events.some((e) => e.kind === "no-match"));

// ---- authoriseUpgrade gating ----
//
// Fresh proxy + upstream so the auth path is isolated from the
// per-case state above (event log, connection counters, etc.).
{
  const authEvents = [];
  const authedConnections = [];
  const upstream2 = net.createServer((sock) => {
    authedConnections.push(sock);
    sock.on("data", () => sock.write("HELLO\n"));
  });
  await new Promise((res) => upstream2.listen(0, "127.0.0.1", res));
  const upstream2Port = upstream2.address().port;

  let nextAuth = { kind: "deny-anon" };
  const httpServer2 = http.createServer();
  const detach2 = attachWsProxy(httpServer2, {
    upstream: { host: "127.0.0.1", port: upstream2Port },
    connectTimeoutMs: 2000,
    authoriseUpgrade: async () => nextAuth,
    onEvent: (e) => authEvents.push(e),
  });
  await new Promise((res) => httpServer2.listen(0, "127.0.0.1", res));
  const proxy2Port = httpServer2.address().port;

  const sendUpgrade = async (path) => {
    const sock = net.connect(proxy2Port, "127.0.0.1");
    await new Promise((res) => sock.once("connect", res));
    sock.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: localhost:${proxy2Port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: x\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
    return sock;
  };

  // deny-anon: client sees 401, upstream never dialled.
  nextAuth = { kind: "deny-anon" };
  {
    const sock = await sendUpgrade("/ws/project/proj1");
    const got = await readUntil(sock, (b) =>
      b.toString("utf8").includes("401"),
    );
    assert.match(got.toString("utf8"), /HTTP\/1\.1 401/);
    sock.destroy();
  }
  assert.equal(
    authedConnections.length,
    0,
    "upstream must not be dialled on auth reject",
  );
  assert.ok(authEvents.some((e) => e.kind === "unauthorised"));

  // deny-acl: client sees 403, upstream still not dialled.
  nextAuth = { kind: "deny-acl" };
  {
    const sock = await sendUpgrade("/ws/project/proj1b");
    const got = await readUntil(sock, (b) =>
      b.toString("utf8").includes("403"),
    );
    assert.match(got.toString("utf8"), /HTTP\/1\.1 403/);
    sock.destroy();
  }
  assert.equal(
    authedConnections.length,
    0,
    "upstream must not be dialled on ACL reject",
  );
  assert.ok(
    authEvents.some(
      (e) => e.kind === "forbidden" && e.projectId === "proj1b",
    ),
    `expected forbidden event: ${JSON.stringify(authEvents)}`,
  );

  // Accept: bytes flow as before.
  nextAuth = { kind: "allow" };
  {
    const sock = await sendUpgrade("/ws/project/proj2");
    const got = await readUntil(sock, (b) =>
      b.toString("utf8").includes("HELLO"),
    );
    assert.ok(got.toString("utf8").includes("HELLO"));
    sock.destroy();
  }
  assert.equal(authedConnections.length, 1);
  assert.ok(authEvents.some((e) => e.kind === "upstream-connected"));

  // Authoriser throws → 401, upstream not dialled, auth-error event.
  const authEvents2 = [];
  const httpServer3 = http.createServer();
  const detach3 = attachWsProxy(httpServer3, {
    upstream: { host: "127.0.0.1", port: upstream2Port },
    connectTimeoutMs: 2000,
    authoriseUpgrade: async () => {
      throw new Error("db down");
    },
    onEvent: (e) => authEvents2.push(e),
  });
  await new Promise((res) => httpServer3.listen(0, "127.0.0.1", res));
  const proxy3Port = httpServer3.address().port;
  {
    const sock = net.connect(proxy3Port, "127.0.0.1");
    await new Promise((res) => sock.once("connect", res));
    sock.write(
      `GET /ws/project/proj3 HTTP/1.1\r\n` +
        `Host: localhost:${proxy3Port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: x\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
    const got = await readUntil(sock, (b) =>
      b.toString("utf8").includes("401"),
    );
    assert.match(got.toString("utf8"), /HTTP\/1\.1 401/);
    sock.destroy();
  }
  assert.equal(
    authedConnections.length,
    1,
    "upstream must not be dialled when authoriser throws",
  );
  assert.ok(
    authEvents2.some(
      (e) => e.kind === "auth-error" && e.message === "db down",
    ),
    `expected auth-error event: ${JSON.stringify(authEvents2)}`,
  );

  detach2();
  detach3();
  await new Promise((res) => httpServer2.close(res));
  await new Promise((res) => httpServer3.close(res));
  await new Promise((res) => upstream2.close(res));
}

// ---- upstream as a resolver function ----
//
// `WsProxyOptions.upstream` accepts a `(projectId) => Promise<…>`
// so per-project Machine routing (M7.1.2) can be wired without
// touching the proxy. Two cases: happy resolve, and resolver
// rejection → 502 (upstream never dialled).

{
  const upstreamConns = [];
  const upstream = net.createServer((sock) => {
    upstreamConns.push(sock);
    sock.on("data", () => sock.write("HELLO\n"));
  });
  await new Promise((res) => upstream.listen(0, "127.0.0.1", res));
  const upPort = upstream.address().port;

  const seenIds = [];
  const events = [];
  const httpServer4 = http.createServer();
  const detach4 = attachWsProxy(httpServer4, {
    upstream: (projectId) => {
      seenIds.push(projectId);
      return Promise.resolve({ host: "127.0.0.1", port: upPort });
    },
    connectTimeoutMs: 2000,
    onEvent: (e) => events.push(e),
  });
  await new Promise((res) => httpServer4.listen(0, "127.0.0.1", res));
  const proxyPort4 = httpServer4.address().port;

  const sock = net.connect(proxyPort4, "127.0.0.1");
  await new Promise((res) => sock.once("connect", res));
  sock.write(
    `GET /ws/project/proj-resolve HTTP/1.1\r\n` +
      `Host: localhost:${proxyPort4}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: x\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  );
  const got = await readUntil(sock, (b) =>
    b.toString("utf8").includes("HELLO"),
  );
  assert.ok(got.toString("utf8").includes("HELLO"));
  sock.destroy();
  assert.deepEqual(seenIds, ["proj-resolve"]);
  assert.ok(events.some((e) => e.kind === "upstream-connected"));

  detach4();
  await new Promise((res) => httpServer4.close(res));
  await new Promise((res) => upstream.close(res));
}

// Resolver rejects → 502, upstream never dialled.
{
  const events = [];
  const httpServer5 = http.createServer();
  const detach5 = attachWsProxy(httpServer5, {
    upstream: () => Promise.reject(new Error("machines api down")),
    connectTimeoutMs: 2000,
    onEvent: (e) => events.push(e),
  });
  await new Promise((res) => httpServer5.listen(0, "127.0.0.1", res));
  const proxyPort5 = httpServer5.address().port;
  const sock = net.connect(proxyPort5, "127.0.0.1");
  await new Promise((res) => sock.once("connect", res));
  sock.write(
    `GET /ws/project/proj-resolve-fail HTTP/1.1\r\n` +
      `Host: localhost:${proxyPort5}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: x\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  );
  const got = await readUntil(sock, (b) => b.toString("utf8").includes("502"));
  assert.match(got.toString("utf8"), /HTTP\/1\.1 502/);
  sock.destroy();
  assert.ok(
    events.some(
      (e) => e.kind === "resolve-error" && e.message === "machines api down",
    ),
    `expected resolve-error event: ${JSON.stringify(events)}`,
  );
  detach5();
  await new Promise((res) => httpServer5.close(res));
}

console.log("wsProxy ok");
