// Server-side delete-project verb for the `/projects` dashboard.
//
// Optimistic ordering (M13.2(b).2, iter 254):
//   1. Look up the `machine_assignments` row for `projectId` (sub-ms).
//   2. Delete the `projects` row in the DB. The `machine_assignments`
//      FK cascades, so the assignment row is removed in the same
//      transaction. The user-visible row is now gone (~50 ms on
//      local Postgres, a few hundred ms on live).
//   3. Kick off Fly `destroyMachine` as fire-and-forget if there
//      was an assignment and credentials are configured. Errors are
//      logged, never raised — the orphan-tag sweep in `globalSetup`
//      teardown is the safety net.
//
// The result carries a `destroyComplete` Promise so tests can await
// the background task deterministically; the production caller
// (`/projects` `?/delete` form action) ignores it and redirects
// straight away.
//
// The Machine destroy step is best-effort when `FLY_API_TOKEN` /
// `SIDECAR_APP_NAME` are not configured (local dev) — the DB row is
// still removed.

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
  /** Injection point for tests; defaults to `console.error`. */
  readonly logError?: (msg: string, err: unknown) => void;
}

export interface DeleteProjectResult {
  readonly hadAssignment: boolean;
  readonly rowDeleted: boolean;
  /** Resolves when the background Fly destroy attempt has finished
   *  (or was skipped). `destroyed` is true on a successful Fly 2xx;
   *  false if there was no assignment, no credentials, the Machine
   *  was already gone (404), or the call failed. `error` is set
   *  only on a non-404 failure and is also logged via `logError`. */
  readonly destroyComplete: Promise<{
    readonly destroyed: boolean;
    readonly error?: unknown;
  }>;
}

export async function deleteProject(
  input: DeleteProjectInput,
): Promise<DeleteProjectResult> {
  const assignment = await getMachineAssignmentByProjectId(
    input.db,
    input.projectId,
  );

  // Optimistic: DB row first. Cascade removes the machine_assignments
  // row so the orphan sweep is the only thing that can still reap the
  // Fly Machine if the background destroy below fails.
  const rowDeleted = await dbDeleteProject(input.db, input.projectId);

  const destroyComplete = runBackgroundDestroy({
    assignment,
    projectId: input.projectId,
    env: input.env,
    makeMachinesClient: input.makeMachinesClient,
    logError: input.logError ?? defaultLogError,
  });

  return {
    hadAssignment: assignment !== null,
    rowDeleted,
    destroyComplete,
  };
}

async function runBackgroundDestroy(opts: {
  readonly assignment: { readonly machineId: string } | null;
  readonly projectId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly makeMachinesClient?: DeleteProjectInput["makeMachinesClient"];
  readonly logError: (msg: string, err: unknown) => void;
}): Promise<{ readonly destroyed: boolean; readonly error?: unknown }> {
  const { assignment } = opts;
  if (assignment === null) return { destroyed: false };

  const token = opts.env.FLY_API_TOKEN ?? "";
  const appName = opts.env.SIDECAR_APP_NAME ?? "";
  if (token === "" || appName === "") return { destroyed: false };

  const makeClient =
    opts.makeMachinesClient ??
    ((o) => new MachinesClient({ token: o.token, appName: o.appName }));
  const client = makeClient({ token, appName });
  try {
    await client.destroyMachine(assignment.machineId, { force: true });
    return { destroyed: true };
  } catch (err) {
    if (isAlreadyGone(err)) return { destroyed: false };
    opts.logError(
      `deleteProject: background destroyMachine failed for ` +
        `project=${opts.projectId} machine=${assignment.machineId}`,
      err,
    );
    return { destroyed: false, error: err };
  }
}

function defaultLogError(msg: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(msg, err);
}

function isAlreadyGone(err: unknown): boolean {
  if (err instanceof FlyApiError) return err.status === 404;
  if (typeof err === "object" && err !== null) {
    const rec = err as { status?: unknown };
    return rec.status === 404;
  }
  return false;
}
