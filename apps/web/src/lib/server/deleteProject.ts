// Server-side delete-project verb for the `/projects` dashboard.
//
// Composes the existing primitives:
//   1. Look up the `machine_assignments` row for `projectId`.
//   2. If a row exists, call the Fly Machines API `destroyMachine`
//      with `force: true`. A 404 is treated as success ("already
//      gone").
//   3. Delete the `projects` row. The `machine_assignments` FK
//      cascades, so the assignment row is removed in the same
//      transaction.
//
// The Machine destroy step is best-effort when `FLY_API_TOKEN` /
// `SIDECAR_APP_NAME` are not configured (local dev) — the DB row is
// still removed. When configured and the destroy fails non-404, the
// error propagates so the form action can return a fail() and the
// caller can retry.

import {
  deleteProject as dbDeleteProject,
  getMachineAssignmentByProjectId,
} from "@tex-center/db";
import type { DrizzleDb } from "@tex-center/db";

import { FlyApiError, MachinesClient } from "./flyMachines.js";

export interface DeleteProjectInput {
  readonly db: DrizzleDb;
  readonly projectId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injection point for tests; defaults to constructing a real
   *  `MachinesClient`. */
  readonly makeMachinesClient?: (opts: {
    readonly token: string;
    readonly appName: string;
  }) => Pick<MachinesClient, "destroyMachine">;
}

export interface DeleteProjectResult {
  readonly hadAssignment: boolean;
  readonly machineDestroyed: boolean;
  readonly rowDeleted: boolean;
}

export async function deleteProject(
  input: DeleteProjectInput,
): Promise<DeleteProjectResult> {
  const assignment = await getMachineAssignmentByProjectId(
    input.db,
    input.projectId,
  );

  let machineDestroyed = false;
  if (assignment) {
    const token = input.env.FLY_API_TOKEN ?? "";
    const appName = input.env.SIDECAR_APP_NAME ?? "";
    if (token !== "" && appName !== "") {
      const makeClient =
        input.makeMachinesClient ??
        ((o) => new MachinesClient({ token: o.token, appName: o.appName }));
      const client = makeClient({ token, appName });
      try {
        await client.destroyMachine(assignment.machineId, { force: true });
        machineDestroyed = true;
      } catch (err) {
        if (!isAlreadyGone(err)) throw err;
        // 404 — already gone; the post-condition is satisfied.
      }
    }
  }

  const rowDeleted = await dbDeleteProject(input.db, input.projectId);
  return {
    hadAssignment: assignment !== null,
    machineDestroyed,
    rowDeleted,
  };
}

function isAlreadyGone(err: unknown): boolean {
  if (err instanceof FlyApiError) return err.status === 404;
  if (typeof err === "object" && err !== null) {
    const rec = err as { status?: unknown };
    return rec.status === 404;
  }
  return false;
}
