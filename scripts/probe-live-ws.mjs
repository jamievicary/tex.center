// Iter 147 — live WS-upgrade diagnosis probe.
//
// Required env:
//   DATABASE_URL                  (e.g. via flyctl proxy 5435:5432 → 127.0.0.1:5435/tex_center)
//   SESSION_SIGNING_KEY           base64url 32-byte HMAC key (creds/session-signing-key.txt)
//   TEXCENTER_LIVE_USER_ID        target user (creds/live-user-id.txt)
//
// Captures: authed WS upgrade against wss://tex.center/ws/project/<id>
// using mintSession to produce a valid tc_session cookie. Logs the
// outcome (101 upgrade / non-101 response / hang / error) plus the
// raw response headers and body where applicable, so iter 148+ can
// see exactly which layer breaks.

import { request as httpsRequest } from "node:https";

import {
  closeDb,
  createDb,
  createProject,
  deleteSession,
  listProjectsByOwnerId,
} from "@tex-center/db";

import { mintSession } from "../tests_gold/lib/src/mintSession.js";

const LIVE_HOST = "tex.center";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`MISSING ${name}`);
    process.exit(2);
  }
  return v;
}

function base64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function probe({ path, cookieValue, timeoutMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = httpsRequest({
      host: LIVE_HOST,
      port: 443,
      method: "GET",
      path,
      timeout: timeoutMs,
      headers: {
        Host: LIVE_HOST,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Cookie: `tc_session=${cookieValue}`,
      },
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve({
        kind: "upgrade",
        status: res.statusCode,
        headers: res.headers,
        elapsedMs: Date.now() - start,
      });
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          kind: "response",
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8").slice(0, 1000),
          elapsedMs: Date.now() - start,
        }),
      );
    });
    req.on("error", (e) =>
      resolve({ kind: "error", message: e.message, code: e.code, elapsedMs: Date.now() - start }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ kind: "timeout", elapsedMs: Date.now() - start });
    });
    req.end();
  });
}

const databaseUrl = need("DATABASE_URL");
const signingKeyB64u = need("SESSION_SIGNING_KEY");
const userId = need("TEXCENTER_LIVE_USER_ID");

const signingKey = base64urlToBytes(signingKeyB64u);

const h = createDb(databaseUrl, { onnotice: () => {} });
let sid = null;
let createdProjectId = null;

try {
  // 1. Find an owned project, or create one.
  const owned = await listProjectsByOwnerId(h.db, userId);
  let projectId;
  if (owned.length > 0) {
    projectId = owned[0].id;
    console.log(`USING existing project ${projectId} (${owned.length} total)`);
  } else {
    const p = await createProject(h.db, {
      ownerId: userId,
      name: `probe-iter147-${Date.now()}`,
    });
    projectId = p.id;
    createdProjectId = p.id;
    console.log(`CREATED probe project ${projectId}`);
  }

  // 2. Mint a session.
  const session = await mintSession({ db: h.db, signingKey, userId });
  sid = session.sid;
  console.log(`MINTED session sid=${sid}`);

  // 3. Probe WS upgrade with a generous timeout (cold-start can be 30-60s).
  console.log("PROBING wss://tex.center/ws/project/" + projectId);
  const result = await probe({
    path: `/ws/project/${projectId}`,
    cookieValue: session.cookieValue,
    timeoutMs: 90_000,
  });
  console.log("RESULT:");
  console.log(JSON.stringify(result, null, 2));

  // 4. Probe with a bogus project id (should be 403 deny-acl, confirms
  //    cookie itself is valid).
  const bogus = await probe({
    path: `/ws/project/00000000-0000-0000-0000-000000000000`,
    cookieValue: session.cookieValue,
    timeoutMs: 15_000,
  });
  console.log("BOGUS-id RESULT:");
  console.log(JSON.stringify(bogus, null, 2));
} catch (err) {
  console.error("PROBE ERROR:", err);
  process.exitCode = 1;
} finally {
  if (sid) {
    try {
      await deleteSession(h.db, sid);
      console.log(`CLEANUP deleted session ${sid}`);
    } catch (e) {
      console.error("cleanup session failed:", e.message);
    }
  }
  if (createdProjectId) {
    console.log(`NOTE created project ${createdProjectId} left in place (intentional; reuse on retry)`);
  }
  await closeDb(h);
}
