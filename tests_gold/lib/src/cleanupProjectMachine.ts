// Teardown helper for live probes that spawn a per-project Fly
// Machine. Composes the two existing primitives the control plane
// already uses on its hot path (M7.1.0, M7.1.1):
//
//   1. Look up the `machine_assignments` row for `projectId`.
//   2. If a row exists, `destroyMachine(id, { force: true })`. A
//      404 from the Machines API is treated as success — "already
//      gone" is the desired post-condition.
//   3. Delete the `machine_assignments` row.
//
// The helper is parameterised by minimal duck-type interfaces so
// the probe wires real `MachinesClient` + drizzle-backed
// assignment functions, while unit tests can inject pure stubs
// without needing Fly or Postgres.
//
// Why this lives in `tests_gold/lib/` rather than `apps/web`:
// production code never destroys per-project Machines on demand
// (idle-stop handles that, M7.1.4 / M7.3). This is strictly a
// test-side teardown utility — the live WS-upgrade probe spawns
// a Machine it doesn't otherwise need, and must reap it before
// the next iteration.

export interface MachineDestroyer {
  destroyMachine(
    machineId: string,
    opts?: { readonly force?: boolean },
  ): Promise<void>;
}

export interface AssignmentStore {
  getAssignment(
    projectId: string,
  ): Promise<{ readonly machineId: string } | null>;
  deleteAssignment(projectId: string): Promise<boolean>;
}

export interface CleanupProjectMachineInput {
  readonly projectId: string;
  readonly machines: MachineDestroyer;
  readonly assignments: AssignmentStore;
}

export interface CleanupProjectMachineResult {
  /** A row existed in `machine_assignments` for this project at start. */
  readonly hadAssignment: boolean;
  /** Whether the destroy call returned cleanly. False when the API
   *  reported 404 (machine already gone) or no assignment existed. */
  readonly destroyed: boolean;
  /** Whether a row was deleted from `machine_assignments`. */
  readonly rowDeleted: boolean;
}

export async function cleanupProjectMachine(
  input: CleanupProjectMachineInput,
): Promise<CleanupProjectMachineResult> {
  const assignment = await input.assignments.getAssignment(input.projectId);
  let destroyed = false;
  if (assignment) {
    try {
      await input.machines.destroyMachine(assignment.machineId, {
        force: true,
      });
      destroyed = true;
    } catch (err) {
      if (!isAlreadyGone(err)) throw err;
      destroyed = false;
    }
  }
  const rowDeleted = await input.assignments.deleteAssignment(input.projectId);
  return {
    hadAssignment: assignment !== null,
    destroyed,
    rowDeleted,
  };
}

// Structural check rather than `instanceof FlyApiError` so this
// module stays free of an import into `apps/web`. Any error whose
// `.status` is 404 is treated as "already gone".
function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { status?: unknown };
  return rec.status === 404;
}
