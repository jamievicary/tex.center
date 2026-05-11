// Live deploy-verification probes (M8.pw.2).
//
// Replaces the ad-hoc `node -e '…'` snippets in `deploy/VERIFY.md`
// with a Playwright spec so deploy-touching iterations have a
// single command — `pnpm exec playwright test --config
// tests_gold/playwright.config.ts --project=live` — that asserts
// the live control plane behaves correctly end-to-end.
//
// All assertions target https://tex.center (the `live` project's
// baseURL). On any other project the entire file self-skips, so
// it does not impose live-network access on default gold runs.
//
// Probes:
//   1. GET /healthz                  → 200, body contains
//                                       `tex-center-web-v1`.
//   2. GET /                         → 200 (white sign-in page).
//   3. GET /auth/google/start        → 302 to accounts.google.com
//                                       with client_id +
//                                       redirect_uri=…/auth/google/callback.
//   4. UPGRADE /ws/project/smoke     → 401 (auth fail-closed,
//                                       no sidecar dial).
//   5. UPGRADE /ws/nope              → 404 (unknown WS path).

import { request as httpsRequest } from "node:https";
import { test, expect } from "@playwright/test";

const LIVE_HOST = "tex.center";

test.describe("live deploy verification", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLive runs only on the live project",
    );
  });

  test("healthz returns 200 with tex-center-web-v1 marker", async ({
    request,
  }) => {
    const r = await request.get("/healthz");
    expect(r.status(), "/healthz status").toBe(200);
    const body = await r.text();
    expect(body, "/healthz body").toContain("tex-center-web-v1");
  });

  test("/ returns 200 HTML (white sign-in page)", async ({ request }) => {
    const r = await request.get("/");
    expect(r.status(), "/ status").toBe(200);
    expect(r.headers()["content-type"] ?? "", "/ content-type").toContain(
      "text/html",
    );
  });

  test("/auth/google/start 302s to accounts.google.com with client_id", async ({
    request,
  }) => {
    const r = await request.get("/auth/google/start", { maxRedirects: 0 });
    expect(r.status(), "/auth/google/start status").toBe(302);
    const loc = r.headers()["location"] ?? "";
    expect(loc).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const u = new URL(loc);
    expect(u.searchParams.get("client_id"), "client_id").toBeTruthy();
    expect(u.searchParams.get("redirect_uri")).toBe(
      `https://${LIVE_HOST}/auth/google/callback`,
    );
  });

  test("WS upgrade /ws/project/smoke without cookie → 401", async () => {
    const result = await probeUpgrade("/ws/project/smoke");
    expect(result).toBe("response 401");
  });

  test("WS upgrade /ws/nope → 404", async () => {
    const result = await probeUpgrade("/ws/nope");
    expect(result).toBe("response 404");
  });
});

function probeUpgrade(path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = httpsRequest({
      host: LIVE_HOST,
      port: 443,
      method: "GET",
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Host: LIVE_HOST,
      },
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve(`upgrade ${res.statusCode}`);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(`response ${res.statusCode}`);
    });
    req.on("error", (e) => resolve(`ERR ${e.message}`));
    req.end();
  });
}
