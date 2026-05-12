// Iter 156 — payload-bearing live WS probe.
//
// Builds on `scripts/probe-live-ws.mjs` (which only verifies the
// HTTP/1.1 → WebSocket upgrade). This script keeps the socket open
// after upgrade, decodes the leading frames the sidecar sends on
// connect (`hello` control + initial Yjs state + `file-list`),
// sends a `view` control frame back, and asserts the upstream
// neither closes nor errors within a short observation window.
//
// This is the first probe that actually exercises the runtime
// memory floor that landed in iter 154 (per-project Machines now
// guest 1024MB instead of 256MB) — the bare upgrade handshake of
// `probe-live-ws.mjs` barely allocates.
//
// Required env (same set as probe-live-ws.mjs):
//   DATABASE_URL                  (e.g. via flyctl proxy 5435:5432)
//   SESSION_SIGNING_KEY           base64url 32-byte HMAC key
//   TEXCENTER_LIVE_USER_ID        target user
//
// Exit status: 0 on success (upgrade + hello + file-list observed,
// no early close); 1 on probe error / unexpected close / timeout.

import { WebSocket } from "ws";

import {
  closeDb,
  createDb,
  createProject,
  deleteSession,
  listProjectsByOwnerId,
} from "@tex-center/db";
import { decodeFrame, encodeControl } from "@tex-center/protocol";

import { mintSession } from "../tests_gold/lib/src/mintSession.js";

const LIVE_HOST = "tex.center";

// Bounded observation windows. Both have hard exits — no
// open-ended waits, per the iter-150 leaked-subprocess hygiene
// rule.
const UPGRADE_TIMEOUT_MS = 90_000; // cold-start can be 30–60s
const FRAMES_TIMEOUT_MS = 30_000; // post-upgrade hello+filelist
const POST_VIEW_QUIET_MS = 3_000; // confirm no immediate close

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

function probePayload({ projectId, cookieValue }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = `wss://${LIVE_HOST}/ws/project/${projectId}`;
    const ws = new WebSocket(url, {
      headers: { Cookie: `tc_session=${cookieValue}` },
      handshakeTimeout: UPGRADE_TIMEOUT_MS,
    });

    const observed = {
      upgraded: false,
      helloSeen: false,
      fileListSeen: false,
      docUpdateSeen: false,
      otherFrames: 0,
      decodeErrors: 0,
      files: null,
      closeCode: null,
      closeReason: null,
      errorMessage: null,
      elapsedMs: 0,
    };

    let framesTimer = null;
    let quietTimer = null;

    function finish(kind) {
      if (framesTimer) clearTimeout(framesTimer);
      if (quietTimer) clearTimeout(quietTimer);
      observed.elapsedMs = Date.now() - start;
      try {
        ws.close();
      } catch {
        // Ignore — socket may already be closed.
      }
      resolve({ kind, ...observed });
    }

    ws.on("upgrade", () => {
      observed.upgraded = true;
    });

    ws.on("open", () => {
      // Begin the post-upgrade frame-collection window.
      framesTimer = setTimeout(() => {
        finish(observed.helloSeen && observed.fileListSeen ? "ok" : "timeout-frames");
      }, FRAMES_TIMEOUT_MS);
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        observed.otherFrames++;
        return;
      }
      const frame = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
      let decoded;
      try {
        decoded = decodeFrame(frame);
      } catch {
        observed.decodeErrors++;
        return;
      }
      if (decoded.kind === "control") {
        if (decoded.message.type === "hello") {
          observed.helloSeen = true;
          // Send a payload-bearing control frame: switch viewing
          // page. This crosses the proxy in the client→upstream
          // direction (the open-only assertion proves nothing
          // about that leg).
          try {
            ws.send(encodeControl({ type: "view", page: 1 }));
          } catch (e) {
            observed.errorMessage = `send-failed: ${e?.message ?? e}`;
          }
        } else if (decoded.message.type === "file-list") {
          observed.fileListSeen = true;
          observed.files = decoded.message.files;
          // Quiet-window: leave the socket open briefly to confirm
          // the upstream doesn't immediately close (which would be
          // a cgroup-kill or framing error).
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish("ok"), POST_VIEW_QUIET_MS);
        }
      } else if (decoded.kind === "doc-update") {
        observed.docUpdateSeen = true;
      } else {
        observed.otherFrames++;
      }
    });

    ws.on("error", (err) => {
      observed.errorMessage = err?.message ?? String(err);
    });

    ws.on("unexpected-response", (_req, res) => {
      observed.errorMessage = `unexpected-response status=${res.statusCode}`;
      finish("unexpected-response");
    });

    ws.on("close", (code, reason) => {
      observed.closeCode = code;
      observed.closeReason = reason ? Buffer.from(reason).toString("utf8") : "";
      // If close arrives before our quiet timer fires, that's the
      // failure mode this probe exists to catch.
      if (quietTimer || !observed.fileListSeen) {
        finish("closed-early");
      }
    });
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
  const owned = await listProjectsByOwnerId(h.db, userId);
  let projectId;
  if (owned.length > 0) {
    projectId = owned[0].id;
    console.log(`USING existing project ${projectId} (${owned.length} total)`);
  } else {
    const p = await createProject(h.db, {
      ownerId: userId,
      name: `probe-iter156-${Date.now()}`,
    });
    projectId = p.id;
    createdProjectId = p.id;
    console.log(`CREATED probe project ${projectId}`);
  }

  const session = await mintSession({ db: h.db, signingKey, userId });
  sid = session.sid;
  console.log(`MINTED session sid=${sid}`);

  console.log(`PROBING wss://tex.center/ws/project/${projectId} (payload-bearing)`);
  const result = await probePayload({ projectId, cookieValue: session.cookieValue });
  console.log("RESULT:");
  console.log(JSON.stringify(result, null, 2));

  if (result.kind !== "ok" || !result.helloSeen || !result.fileListSeen) {
    process.exitCode = 1;
  }
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
    console.log(
      `NOTE created project ${createdProjectId} left in place (intentional; reuse on retry)`,
    );
  }
  await closeDb(h);
}
