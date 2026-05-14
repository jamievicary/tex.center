// Live WS-upgrade-with-cookie probe (M7.1.3.2.b.1).
//
// Asserts that the control plane, when handed a valid session
// cookie and a real `projects.id`, completes a WebSocket upgrade
// against `/ws/project/<id>` by spawning a per-project Fly Machine
// via `upstreamResolver` and proxying through to it. The expected
// raw response is `HTTP/1.1 101 Switching Protocols`.
//
// Cost: each run mints a fresh Fly Machine in `tex-center-sidecar`
// (cold-start ~30–60s). The iter-116 cleanup helper
// (`cleanupProjectMachine`) is run in a try/finally to destroy the
// Machine and delete the `machine_assignments` row before the test
// returns; the project row + session row are also dropped. A
// non-404 destroy error preserves the assignment row so a later
// retry has a real `machine_id` to work with.
//
// Gating: live project only; further self-skips on missing
// `FLY_API_TOKEN` or `SIDECAR_APP_NAME` (the resolver fixes the
// destroy target to that single app). The `authedPage`-style `db`
// worker fixture self-skips on missing live-DB env, so under the
// default `tests_gold` run nothing here executes.
//
// Why no Playwright browser? The upgrade handshake is HTTP+headers
// only; driving it through Chrome would not add coverage but would
// double the surface area (Origin handling, mixed-content, etc.).
// `node:https.request` exposes the `'upgrade'` event directly,
// which is exactly the status this probe needs to assert.

import { request as httpsRequest } from "node:https";

import { createProject, deleteSession } from "@tex-center/db";

import { mintSession } from "../lib/src/mintSession.js";

import { test, expect } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";

const LIVE_HOST = "tex.center";

test.describe("live WS-upgrade with cookie", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveWsUpgrade runs only on the live project",
    );
  });

  test("authed upgrade /ws/project/<id> → 101 from real Machine", async ({
    db,
  }) => {
    const token = process.env.FLY_API_TOKEN ?? "";
    const appName = process.env.SIDECAR_APP_NAME ?? "";
    test.skip(
      token === "" || appName === "",
      "WS-upgrade probe needs FLY_API_TOKEN + SIDECAR_APP_NAME",
    );

    // Cold-start a per-project Machine can take ~30–60s. The
    // upgrade promise plus the destroy round-trip in `finally`
    // both fit inside 5 minutes with margin.
    test.setTimeout(5 * 60_000);

    const drizzle = db.db.db;

    const project = await createProject(drizzle, {
      ownerId: db.userId,
      name: `ws-upgrade-probe-${Date.now()}`,
    });
    const session = await mintSession({
      db: drizzle,
      signingKey: db.signingKey,
      userId: db.userId,
    });

    try {
      const result = await probeWsUpgrade({
        host: LIVE_HOST,
        port: 443,
        path: `/ws/project/${project.id}`,
        cookieValue: session.cookieValue,
      });
      expect(result.kind, `WS upgrade result: ${JSON.stringify(result)}`).toBe(
        "upgrade",
      );
      expect(result.status).toBe(101);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle,
      });
      await deleteSession(drizzle, session.sid).catch(() => {});
    }
  });
});

interface UpgradeProbeInput {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly cookieValue: string;
}

type UpgradeProbeResult =
  | { readonly kind: "upgrade"; readonly status: number }
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "error"; readonly message: string };

function probeWsUpgrade(
  input: UpgradeProbeInput,
): Promise<UpgradeProbeResult> {
  return new Promise((resolve) => {
    const req = httpsRequest({
      host: input.host,
      port: input.port,
      method: "GET",
      path: input.path,
      headers: {
        Host: input.host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Cookie: `tc_session=${input.cookieValue}`,
      },
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve({ kind: "upgrade", status: res.statusCode ?? 0 });
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          kind: "response",
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (e) => resolve({ kind: "error", message: e.message }));
    req.end();
  });
}

