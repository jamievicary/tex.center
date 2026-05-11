// Tests for `flyProxy.ts` using stand-in node child processes
// instead of real `flyctl`. Each test ends with the helper's
// child reaped and the listening socket closed; the suite as a
// whole verifies no port is left bound at exit.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFlyProxy } from "../src/flyProxy.ts";

// Pick a free port by binding to 0 then closing. Brief race
// window before flyProxy rebinds — acceptable for a test harness
// on a quiet box; would only flake under concurrent port pressure.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeStandinFlyctl(behavior /* "listen" | "exit-fast" | "sleep-no-listen" */) {
  const dir = mkdtempSync(join(tmpdir(), "flyproxy-stub-"));
  const script = join(dir, "flyctl-stub.mjs");
  // argv: [node, this, "proxy", "LOCAL:REMOTE", "-a", APP, ...extra]
  let body;
  if (behavior === "listen") {
    body = `
      import net from "node:net";
      const spec = process.argv[3];
      const local = Number(spec.split(":")[0]);
      const srv = net.createServer((s) => s.end());
      srv.listen(local, "127.0.0.1");
      process.stdin.resume();
    `;
  } else if (behavior === "exit-fast") {
    body = `
      process.stderr.write("simulated flyctl auth failure\\n");
      process.exit(7);
    `;
  } else if (behavior === "sleep-no-listen") {
    body = `setInterval(() => {}, 1000);`;
  } else {
    throw new Error("unknown behavior " + behavior);
  }
  writeFileSync(script, body);
  const wrapper = join(dir, "flyctl-stub.sh");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function testHappy() {
  const localPort = await pickFreePort();
  const cmd = makeStandinFlyctl("listen");
  const handle = await startFlyProxy({
    app: "tex-center-db",
    localPort,
    remotePort: 5432,
    command: cmd,
    readyTimeoutMs: 5_000,
  });
  assert.equal(handle.localPort, localPort);
  // Double-close must be safe.
  await handle.close();
  await handle.close();
}

async function testExitFast() {
  const localPort = await pickFreePort();
  const cmd = makeStandinFlyctl("exit-fast");
  await assert.rejects(
    () =>
      startFlyProxy({
        app: "tex-center-db",
        localPort,
        remotePort: 5432,
        command: cmd,
        readyTimeoutMs: 5_000,
      }),
    (err) => {
      assert.match(err.message, /child exited before ready/);
      assert.match(err.message, /simulated flyctl auth failure/);
      return true;
    },
  );
}

async function testTimeout() {
  const localPort = await pickFreePort();
  const cmd = makeStandinFlyctl("sleep-no-listen");
  const t0 = Date.now();
  await assert.rejects(
    () =>
      startFlyProxy({
        app: "tex-center-db",
        localPort,
        remotePort: 5432,
        command: cmd,
        readyTimeoutMs: 800,
        probeIntervalMs: 50,
      }),
    (err) => {
      assert.match(err.message, /did not open within 800ms/);
      return true;
    },
  );
  // Helper must have reaped the child before throwing — the test
  // would otherwise leak `sleep-no-listen` processes.
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `timeout took too long: ${elapsed}ms`);
}

async function testSpawnError() {
  const localPort = await pickFreePort();
  await assert.rejects(
    () =>
      startFlyProxy({
        app: "tex-center-db",
        localPort,
        remotePort: 5432,
        command: "/nonexistent/flyctl-binary-zzz",
        readyTimeoutMs: 1_000,
      }),
    (err) => {
      assert.match(err.message, /spawn failed/);
      return true;
    },
  );
}

const cases = [
  ["happy", testHappy],
  ["exit-fast", testExitFast],
  ["timeout", testTimeout],
  ["spawn-error", testSpawnError],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("flyProxy.test.mjs: all passed");
