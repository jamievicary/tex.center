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
import {
  describeBootMigrationsStatus,
  runBootMigrations,
} from "./lib/server/bootMigrations.js";
import {
  describeSessionSweepStatus,
  runBootSessionSweep,
} from "./lib/server/sessionSweep.js";
import {
  createSeedDocFor,
  webBlobStoreFromEnv,
} from "./lib/server/blobStore.js";
import { getDb } from "./lib/server/db.js";
import { MachinesClient } from "./lib/server/flyMachines.js";
import { loadSessionSigningKey } from "./lib/server/sessionConfig.js";
import { dbMachineAssignmentStore } from "./lib/server/upstreamResolver.js";
import { buildUpstreamFromEnv } from "./lib/server/upstreamFromEnv.js";
import { makeProjectAccessAuthoriser } from "./lib/server/wsAuth.js";
import {
  getProjectById,
  getProjectSeedDoc,
  getSessionWithUser,
} from "@tex-center/db";

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
    ? makeProjectAccessAuthoriser({
        signingKey,
        sessionCookieName: "tc_session",
        lookupSession: async (sid) => {
          const { db } = getDb();
          return getSessionWithUser(db, sid);
        },
        lookupProjectOwner: async (projectId) => {
          const { db } = getDb();
          const row = await getProjectById(db, projectId);
          return row?.ownerId ?? null;
        },
      })
    : async () => ({ kind: "deny-anon" as const });

// Per-project resolver: when the Fly + sidecar env vars are all
// set, construct a `MachinesClient` + db-backed assignment store and
// route each `/ws/project/<id>` upgrade to that project's Machine.
// Otherwise fall through to the static `SIDECAR_HOST`/`SIDECAR_PORT`
// upstream (M7.0 shared-sidecar path).
//
// `seedDocFor` resolves the bytes baked into the new Machine's
// `SEED_MAIN_DOC_B64` env. The chain is blob → db `seed_doc` → null:
// a persisted cold-storage blob (M20.2) wins over the M15 db seed
// (`createProject({ seedMainDoc })`), which in turn wins over the
// sidecar's `MAIN_DOC_HELLO_WORLD` fallback. Today's
// `LocalFsBlobStore` is per-Machine so the blob branch always misses
// in production; once shared backing storage lands (S3/Tigris),
// reattach-after-cleanup naturally rides the same chain.
const blobStore = webBlobStoreFromEnv();
const resolveUpstream = buildUpstreamFromEnv(process.env, {
  makeMachinesClient: ({ token, appName }) =>
    new MachinesClient({ token, appName }),
  makeStore: () => dbMachineAssignmentStore(getDb().db),
  seedDocFor: createSeedDocFor({
    blobStore,
    getDbSeedDoc: async (projectId) => {
      const { db } = getDb();
      return getProjectSeedDoc(db, projectId);
    },
    onBlobError: ({ projectId, message }) => {
      console.error(
        JSON.stringify({ blob_seed_lookup_error: { projectId, message } }),
      );
    },
  }),
});

// Apply pending DB migrations before accepting traffic. Gated by
// `DATABASE_URL` + `RUN_MIGRATIONS_ON_BOOT=1`; any other state is a
// no-op so the existing stateless path keeps working.
const migrationsStatus = await runBootMigrations(process.env);
console.log(describeBootMigrationsStatus(migrationsStatus));

// Sweep expired session rows. Gated by `SWEEP_SESSIONS_ON_BOOT=1`;
// independent of migrations so ops can flip them separately. A
// sweep failure is non-fatal — log and continue, since the schema
// is still usable and the next deploy will retry.
try {
  const sweepStatus = await runBootSessionSweep(process.env);
  console.log(describeSessionSweepStatus(sweepStatus));
} catch (err) {
  console.error("session sweep failed (non-fatal)", err);
}

const { server } = boot({
  handler,
  host,
  port,
  env: process.env,
  authoriseUpgrade,
  ...(resolveUpstream ? { resolveUpstream } : {}),
  // Structured one-line JSON per WS-proxy lifecycle event. Lets
  // `flyctl logs -a tex-center` show resolver/dial outcomes for
  // every `/ws/project/<id>` upgrade — without this, every
  // failure mode silently 502s and we have no diagnostic trail
  // (iter 163).
  onWsProxyEvent: (event) => {
    console.log(JSON.stringify({ ws_proxy: event }));
  },
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
