// Shared Playwright-side wrapper around
// `tests_gold/lib/src/cleanupProjectMachine.ts` for live specs.
//
// Each live-target spec that triggers per-project Machine creation
// (by hitting `/editor/<id>` and opening the WS) must reap that
// Machine before returning, or the `tex-center-sidecar` Fly app
// accumulates orphans across iterations (see `173b_question.md`).
// This helper centralises the wiring so spec `afterEach` blocks
// stay one line.
//
// Behaviour: if `FLY_API_TOKEN` is missing, this is a no-op (the
// spec was almost certainly skipped or run against `local`). The
// Fly app name defaults to `tex-center-sidecar` to match the live
// deploy; override via `SIDECAR_APP_NAME` if a future iter splits
// the pool.

import { eq } from "drizzle-orm";

import {
  deleteMachineAssignment,
  getMachineAssignmentByProjectId,
  projects,
} from "@tex-center/db";

import {
  cleanupProjectMachine,
  type AssignmentStore,
  type MachineDestroyer,
} from "../../lib/src/cleanupProjectMachine.js";

type Drizzle = Parameters<typeof getMachineAssignmentByProjectId>[0];

export interface CleanupLiveInput {
  readonly projectId: string;
  readonly drizzle: Drizzle;
}

export async function cleanupLiveProjectMachine(
  input: CleanupLiveInput,
): Promise<void> {
  const token = process.env.FLY_API_TOKEN ?? "";
  const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
  if (token === "") return;

  try {
    await cleanupProjectMachine({
      projectId: input.projectId,
      machines: makeMachineDestroyer({ token, appName }),
      assignments: makeAssignmentStore(input.drizzle),
    });
  } catch (err) {
    // Surface but don't throw — afterEach must not mask the
    // original test failure. Next live spec run will retry against
    // the still-present assignment row.
    // eslint-disable-next-line no-console
    console.error("cleanupLiveProjectMachine failed:", err);
  }
  // Best-effort: remove the project row regardless.
  await input.drizzle
    .delete(projects)
    .where(eq(projects.id, input.projectId))
    .catch(() => {});
}

export function makeMachineDestroyer(opts: {
  readonly token: string;
  readonly appName: string;
}): MachineDestroyer {
  return {
    async destroyMachine(machineId, options) {
      const force = options?.force ? "?force=true" : "";
      const url =
        `https://api.machines.dev/v1/apps/${opts.appName}` +
        `/machines/${machineId}${force}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(
          `destroyMachine ${res.status} ${url}: ${body}`,
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    },
  };
}

export function makeAssignmentStore(drizzle: Drizzle): AssignmentStore {
  return {
    async getAssignment(projectId) {
      const row = await getMachineAssignmentByProjectId(drizzle, projectId);
      return row === null ? null : { machineId: row.machineId };
    },
    async deleteAssignment(projectId) {
      return deleteMachineAssignment(drizzle, projectId);
    },
  };
}
