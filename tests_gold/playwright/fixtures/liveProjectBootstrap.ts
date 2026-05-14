// Live-project bootstrap, invoked from `globalSetup.ts` rather
// than from a worker-scoped fixture.
//
// Why globalSetup rather than a fixture: a worker-scoped fixture's
// setup runs lazily inside the FIRST test that requests it, and
// Playwright's per-test `timeout` is the budget covering that
// setup. That coupling forces the per-test timeout to absorb
// ~60–180s of cold Fly Machine boot, contaminating per-test budgets
// for the remaining specs and making "test X took 3 minutes" no
// longer diagnostic. By moving the bootstrap into globalSetup, the
// warm-up sits outside the per-test timeout regime entirely; specs
// run under a tight budget that means what it says (a 45s GT-C is
// a regression, not "noise within a 240s ceiling"). See
// `.autodev/discussion/207_answer.md` for the full reasoning.
//
// Bootstrap responsibilities, in order:
//
//   1. Resolve live DB config (creds set by the gold runner).
//   2. Start a `flyctl proxy` to `tex-center-db`, open a Drizzle
//      handle.
//   3. Create a fresh `projects` row owned by the test user.
//   4. Mint a session cookie for that user.
//   5. Launch a transient Chromium, navigate `/editor/<id>` against
//      the live deploy with the cookie attached, and wait for the
//      first `TAG_PDF_SEGMENT` frame on the project WS — the same
//      "warm" condition the original fixture asserted (per
//      `196_answer.md`).
//   6. Close the browser. Leave the DB + flyProxy handles open so
//      teardown can delete the row and reap the Machine.
//
// Returns a `teardown` closure that cleans up the Machine, deletes
// the project row, closes DB, closes flyProxy. Idempotent on
// repeated invocation (`teardown` is called from globalSetup's
// returned closure, which the runner invokes once).
//
// If `FLY_API_TOKEN` is absent (live creds not provisioned), this
// helper short-circuits and returns `null`. globalSetup uses that
// to skip env-var export, and live specs will skip themselves via
// the existing FULL_PIPELINE / project-name gates.

import { chromium, type Browser } from "@playwright/test";
import { eq } from "drizzle-orm";

import {
  createDb,
  closeDb,
  createProject,
  deleteSession,
  listAllProjectIds,
  projects,
  type DbHandle,
  type ProjectRow,
} from "@tex-center/db";

import {
  buildLiveDbUrl,
  buildSessionCookieSpec,
  resolveLiveDbConfig,
} from "../../lib/src/authedCookie.js";
import { cleanupProjectMachine } from "../../lib/src/cleanupProjectMachine.js";
import { sweepOrphanedSidecarMachines } from "../../lib/src/sweepOrphanedSidecarMachines.js";
import { mintSession } from "../../lib/src/mintSession.js";
import { startFlyProxy, type FlyProxyHandle } from "../../lib/src/flyProxy.js";
import {
  makeAssignmentStore,
  makeMachineDestroyer,
} from "./cleanupLiveProjectMachine.js";
import { TAG_PDF_SEGMENT } from "./wireFrames.js";

// Baseline for the live target. Hard-coded to match the `live`
// project's baseURL in `playwright.config.ts`; if that ever moves,
// both must move together (there's no API for globalSetup to read
// a per-project baseURL from the config).
const LIVE_BASE_URL = "https://tex.center";

// Budget for the one-shot warm-up: cold Fly Machine boot + sidecar
// start + first lualatex round. Per `196_answer.md`: ~60-90s
// realistic, 240s gives safe headroom for deploy-time variance and
// is well above the "regression-vs-noise" threshold.
const WARMUP_TIMEOUT_MS = 240_000;

// Use a non-default local port to avoid colliding with the
// per-worker flyProxy that `authedPage.db` will open later in the
// same process (default 5433). Reading from env first lets the gold
// runner override if a CI host has the port in use.
const BOOTSTRAP_LOCAL_PORT = parseInt(
  process.env.TEXCENTER_GT_BOOTSTRAP_DB_LOCAL_PORT ?? "5443",
  10,
);

export interface LiveBootstrapResult {
  readonly project: ProjectRow;
  readonly teardown: () => Promise<void>;
}

export async function bootstrapLiveProject(): Promise<LiveBootstrapResult | null> {
  const resolved = resolveLiveDbConfig(process.env);
  if (!resolved.ok) {
    // Live creds missing: signal to globalSetup that we should not
    // export env. Live specs will skip via their own gates.
    return null;
  }
  if ((process.env.FLY_API_TOKEN ?? "") === "") {
    return null;
  }

  // Override the local port for THIS proxy only. The worker fixture
  // re-reads env when it opens its own proxy later; that one keeps
  // the default 5433 so we don't collide here.
  const proxy = await startFlyProxy({
    app: resolved.config.app,
    localPort: BOOTSTRAP_LOCAL_PORT,
    remotePort: resolved.config.remotePort,
  });
  // Build a DB URL pointing at our chosen local port (not the
  // resolved config's localPort).
  const bootstrapUrl = buildLiveDbUrl({
    ...resolved.config,
    localPort: BOOTSTRAP_LOCAL_PORT,
  });
  const db: DbHandle = createDb(bootstrapUrl);

  let project: ProjectRow | null = null;
  let browser: Browser | null = null;
  try {
    project = await createProject(db.db, {
      ownerId: resolved.config.userId,
      name: `pw-gt-shared-${Date.now()}`,
    });

    const minted = await mintSession({
      db: db.db,
      signingKey: resolved.config.signingKey,
      userId: resolved.config.userId,
    });
    browser = await chromium.launch();
    const host = new URL(LIVE_BASE_URL).hostname;
    const context = await browser.newContext({ baseURL: LIVE_BASE_URL });
    try {
      await context.addCookies([
        buildSessionCookieSpec({
          value: minted.cookieValue,
          expiresAt: minted.expiresAt,
          host,
          secure: true,
        }),
      ]);
      const page = await context.newPage();
      const started = Date.now();
      let sawFrame = false;
      page.on("websocket", (ws) => {
        if (!ws.url().includes(`/ws/project/${project!.id}`)) return;
        ws.on("framereceived", ({ payload }) => {
          if (typeof payload === "string") return;
          if (payload.length === 0) return;
          if (payload[0] === TAG_PDF_SEGMENT) sawFrame = true;
        });
      });
      await page.goto(`/editor/${project.id}`);
      const deadline = started + WARMUP_TIMEOUT_MS;
      while (!sawFrame) {
        if (Date.now() > deadline) {
          throw new Error(
            `liveProjectBootstrap warm-up: no initial pdf-segment within ` +
              `${WARMUP_TIMEOUT_MS}ms for project ${project.id} ` +
              `(elapsed=${Date.now() - started}ms)`,
          );
        }
        await page.waitForTimeout(250);
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[globalSetup] live warm-up: pdf-segment observed in ` +
          `${Date.now() - started}ms (project ${project.id})`,
      );
    } finally {
      await context.close().catch(() => {});
      await deleteSession(db.db, minted.sid).catch(() => {});
    }
  } catch (err) {
    // Setup failed; release resources we opened so the runner
    // doesn't inherit a leaked proxy/db/browser. Best-effort delete
    // of the project row if we got that far.
    if (project) {
      await db.db
        .delete(projects)
        .where(eq(projects.id, project.id))
        .catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    await closeDb(db).catch(() => {});
    await proxy.close().catch(() => {});
    throw err;
  }

  await browser.close().catch(() => {});

  const teardown = async (): Promise<void> => {
    if (!project) return;
    try {
      const token = process.env.FLY_API_TOKEN ?? "";
      const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
      if (token !== "") {
        try {
          await cleanupProjectMachine({
            projectId: project.id,
            machines: makeMachineDestroyer({ token, appName }),
            assignments: makeAssignmentStore(db.db),
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("liveProjectBootstrap teardown: machine cleanup failed:", err);
        }
      }
      await db.db
        .delete(projects)
        .where(eq(projects.id, project.id))
        .catch(() => {});
      // Orphan-tagged sidecar sweep: after the bootstrap's own
      // project row has been deleted, destroy any other Fly Machine
      // tagged `texcenter_project=<id>` whose `<id>` is no longer
      // in `projects`. Catches both leak shapes from
      // `sweepOrphanedSidecarMachines.ts`'s header — a per-spec
      // cleanup that deleted the row but lost the destroy, and a
      // spec death after Machine create but before assignment-row
      // upsert. Running here, with the bootstrap's DB + token still
      // open, costs one Fly API list per gold run; the count
      // guardrail (`test_sidecar_machine_count.py`) then only sees
      // residual untagged legacy machines.
      const token = process.env.FLY_API_TOKEN ?? "";
      const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
      if (token !== "") {
        try {
          const knownIds = new Set(await listAllProjectIds(db.db));
          const report = await sweepOrphanedSidecarMachines({
            machines: makeFlyMachineSweeper({ token, appName }),
            projects: { async getKnownProjectIds() { return knownIds; } },
          });
          if (report.destroyed.length > 0 || report.failed.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[globalSetup] orphan sweep: inspected=${report.inspected} ` +
                `tagged=${report.tagged} destroyed=${report.destroyed.length} ` +
                `failed=${report.failed.length}`,
            );
            for (const f of report.failed) {
              // eslint-disable-next-line no-console
              console.warn(
                `[globalSetup] orphan sweep failed: machine=${f.machineId} ` +
                  `tag=${f.tag} error=${f.error}`,
              );
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[globalSetup] orphan sweep threw:", err);
        }
      }
    } finally {
      await closeDb(db).catch(() => {});
      await proxy.close().catch(() => {});
    }
  };

  return { project, teardown };
}

// Env-var keys used to carry the bootstrap result across the
// process boundary into worker fixtures. Spec fixtures read these
// and reconstruct a `ProjectRow`. Keys are kept stable so a future
// debug tool can attach to an in-progress run.
// Adapter joining the Fly Machines REST list+destroy verbs into the
// `MachineLister & MachineDestroyer` shape `sweepOrphanedSidecarMachines`
// wants. Kept inline to avoid a second import-from-Playwright path for
// a single use-site.
function makeFlyMachineSweeper(opts: {
  readonly token: string;
  readonly appName: string;
}) {
  const base = `https://api.machines.dev/v1/apps/${opts.appName}/machines`;
  const auth = { Authorization: `Bearer ${opts.token}` };
  return {
    async listMachines() {
      const res = await fetch(base, { headers: auth });
      if (!res.ok) {
        throw new Error(
          `Fly Machines list ${res.status}: ${await res.text()}`,
        );
      }
      const body = (await res.json()) as Array<{
        id: string;
        config?: { metadata?: Record<string, string> | null } | null;
      }>;
      return body.map((m) => ({
        id: m.id,
        metadata: m.config?.metadata ?? null,
      }));
    },
    async destroyMachine(
      machineId: string,
      destroyOpts?: { readonly force?: boolean },
    ) {
      const q = destroyOpts?.force ? "?force=true" : "";
      const res = await fetch(`${base}/${machineId}${q}`, {
        method: "DELETE",
        headers: auth,
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(
          `destroyMachine ${res.status} ${base}/${machineId}: ${body}`,
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    },
  };
}

export const ENV_PROJECT_ID = "TEXCENTER_GT_PROJECT_ID";
export const ENV_PROJECT_OWNER_ID = "TEXCENTER_GT_PROJECT_OWNER_ID";
export const ENV_PROJECT_NAME = "TEXCENTER_GT_PROJECT_NAME";
export const ENV_PROJECT_CREATED_AT = "TEXCENTER_GT_PROJECT_CREATED_AT";
export const ENV_PROJECT_UPDATED_AT = "TEXCENTER_GT_PROJECT_UPDATED_AT";

export function exportProjectToEnv(project: ProjectRow): void {
  process.env[ENV_PROJECT_ID] = project.id;
  process.env[ENV_PROJECT_OWNER_ID] = project.ownerId;
  process.env[ENV_PROJECT_NAME] = project.name;
  process.env[ENV_PROJECT_CREATED_AT] = project.createdAt.toISOString();
  process.env[ENV_PROJECT_UPDATED_AT] = project.updatedAt.toISOString();
}

export function readProjectFromEnv(): ProjectRow | null {
  const id = process.env[ENV_PROJECT_ID];
  const ownerId = process.env[ENV_PROJECT_OWNER_ID];
  const name = process.env[ENV_PROJECT_NAME];
  const createdAt = process.env[ENV_PROJECT_CREATED_AT];
  const updatedAt = process.env[ENV_PROJECT_UPDATED_AT];
  if (!id || !ownerId || !name || !createdAt || !updatedAt) return null;
  return {
    id,
    ownerId,
    name,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
}
