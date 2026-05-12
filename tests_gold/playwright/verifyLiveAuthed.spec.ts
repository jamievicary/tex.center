// Authed live deploy-verification (M7.1.3.2).
//
// Mirrors `verifyLive.spec.ts` but exercises the session-cookie
// path: the `db` worker fixture mints a `tc_session` cookie via the
// rotated `SESSION_SIGNING_KEY` against the live Postgres (via
// `flyctl proxy`), the test attaches the cookie to a browser
// context, then probes endpoints that are gated by the server hook.
//
// Two probes — both confirm the rotated signing key + live DB
// `sessions ⋈ users` lookup work end-to-end:
//
//   1. GET /projects with cookie → 200 (the dashboard). Without
//      cookie the same path is 302 → /, so a 200 here proves the
//      hook accepted the cookie *and* found the matching DB row.
//   2. The reverse sanity check: GET /projects with NO cookie →
//      302 to /. Confirms the route gate stays functional.
//
// Skipped on the `local` project. Worker self-skips if the env
// vars the `db` fixture needs are absent (so the suite stays green
// when run without `TEXCENTER_LIVE_*` set).
//
// WS-upgrade-with-cookie verification (asserting 101 from a real
// per-project Machine) is deliberately separate: it spawns a
// sidecar Machine on every run, which is too expensive for a
// deploy-smoke spec. Tracked as M7.1.3.2.b.

import https from "node:https";

import { test, expect } from "./fixtures/authedPage.js";

const LIVE_HOST = "tex.center";

test.describe("live authed deploy verification", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveAuthed runs only on the live project",
    );
  });

  test("authed GET /projects → 200", async ({ authedPage }) => {
    const r = await authedPage.goto("/projects");
    expect(r?.status(), "/projects status").toBe(200);
    expect(new URL(authedPage.url()).pathname).toBe("/projects");
  });

  test("anon GET /projects → 302 to /", async () => {
    const r = await rawGet("/projects");
    expect(r.status, "/projects anon status").toBe(302);
    expect(r.location).toBe("/");
  });
});

interface RawGetResult {
  readonly status: number;
  readonly location: string | undefined;
}

function rawGet(path: string): Promise<RawGetResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: LIVE_HOST,
        port: 443,
        method: "GET",
        path,
        headers: { Host: LIVE_HOST },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
