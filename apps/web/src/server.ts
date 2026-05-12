// Production entry for the @tex-center/web image. Replaces
// adapter-node's default `build/index.js` so that HTTP Upgrade
// requests on `/ws/project/<id>` can be hijacked and proxied to the
// sidecar over Fly 6PN. Adapter-node's emitted `handler.js`
// continues to serve all non-Upgrade traffic.
//
// This file is bundled by `scripts/build-server-entry.mjs` into
// `build/server.js`; the bundle keeps `./handler.js` external so
// the import below resolves to adapter-node's output at runtime.

// `./handler.js` is the SvelteKit request listener emitted by
// adapter-node. Path is resolved relative to the bundled output
// (`build/server.js`), not this source file.
// @ts-expect-error -- supplied at runtime, no source-tree sibling.
import { handler } from "./handler.js";

import { boot, parsePort } from "./lib/server/boot.js";
import { getDb } from "./lib/server/db.js";
import { MachinesClient } from "./lib/server/flyMachines.js";
import { loadSessionSigningKey } from "./lib/server/sessionConfig.js";
import { dbMachineAssignmentStore } from "./lib/server/upstreamResolver.js";
import { buildUpstreamFromEnv } from "./lib/server/upstreamFromEnv.js";
import { makeSessionAuthoriser } from "./lib/server/wsAuth.js";
import { getSessionWithUser } from "@tex-center/db";

const host = process.env.HOST ?? "0.0.0.0";
const port = parsePort(process.env.PORT, 3000);

// Build the WS-upgrade authoriser. With no signing key configured
// the proxy refuses every upgrade — matching `hooks.server.ts`,
// where a missing key means "anonymous everywhere" and so the
// authenticated-only sidecar path is unreachable.
const signingKey = (() => {
  try {
    return loadSessionSigningKey();
  } catch (err) {
    console.error("SESSION_SIGNING_KEY is malformed; WS proxy will reject all upgrades.", err);
    return null;
  }
})();

const authoriseUpgrade =
  signingKey !== null
    ? makeSessionAuthoriser({
        signingKey,
        sessionCookieName: "tc_session",
        lookupSession: async (sid) => {
          const { db } = getDb();
          return getSessionWithUser(db, sid);
        },
      })
    : async () => false;

// Per-project resolver: when the Fly + sidecar env vars are all
// set, construct a `MachinesClient` + db-backed assignment store and
// route each `/ws/project/<id>` upgrade to that project's Machine.
// Otherwise fall through to the static `SIDECAR_HOST`/`SIDECAR_PORT`
// upstream (M7.0 shared-sidecar path).
const resolveUpstream = buildUpstreamFromEnv(process.env, {
  makeMachinesClient: ({ token, appName }) =>
    new MachinesClient({ token, appName }),
  makeStore: () => dbMachineAssignmentStore(getDb().db),
});

const { server } = boot({
  handler,
  host,
  port,
  env: process.env,
  authoriseUpgrade,
  ...(resolveUpstream ? { resolveUpstream } : {}),
});

server.on("listening", () => {
  console.log(`Listening on http://${host}:${port}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Hard-stop if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
