// Stale-Playwright-project sweep, invoked at gold globalSetup
// startup BEFORE the orphan-Machine sweep
// (`sweepOrphanedSidecarMachines`). Two leak shapes the existing
// sweep cannot self-heal:
//
//   (a) A spec creates a `pw-*` project, the runner crashes before
//       its `afterEach` reaps the Machine, and the project row stays
//       in `projects`. The orphan-Machine sweep then keeps the
//       Machine alive because its `texcenter_project` tag still
//       matches a live project row.
//   (b) Same crash shape, but Fly auto-stop has since destroyed the
//       Machine. The project row + the `machine_assignments` row
//       persist forever; the count test ignores these but the DB
//       fills up indefinitely.
//
// Both leak only happens to projects whose name was created by the
// Playwright bootstrap or by per-spec project creation, which all
// follow the convention `pw-*`. User-created projects (whose names
// are arbitrary) are never touched, regardless of age.
//
// Sequence per stale project:
//   1. Look up `machine_assignments` row for `projectId`.
//   2. If present, call `destroyMachine(id, { force: true })`. A
//      404 is treated as success.
//   3. Delete the `projects` row (cascades the assignment row via
//      the FK declared in `drizzle.ts`).
//
// All I/O is injected via duck-type interfaces so the unit tests
// run without Fly or Postgres. Wiring lives in
// `tests_gold/playwright/fixtures/liveProjectBootstrap.ts`.

import {
  type AssignmentStore,
  type MachineDestroyer,
} from "./cleanupProjectMachine.js";

export interface OldProjectRef {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface ProjectRowDeleter {
  /** Delete `projects.id`; returns true if a row was removed. */
  deleteProject(id: string): Promise<boolean>;
}

export interface CleanupOldPlaywrightInput {
  readonly projects: readonly OldProjectRef[];
  readonly machines: MachineDestroyer;
  readonly assignments: AssignmentStore;
  readonly rows: ProjectRowDeleter;
}

export interface CleanupOldPlaywrightReport {
  readonly inspected: number;
  /** Project IDs whose Machine destroy call resolved cleanly (or 404). */
  readonly machinesDestroyed: readonly string[];
  /** Project IDs whose `projects` row was successfully deleted. */
  readonly rowsDeleted: readonly string[];
  /** Per-project failures collected without aborting the loop. */
  readonly failed: ReadonlyArray<{
    readonly projectId: string;
    readonly stage: "destroy" | "deleteRow" | "lookup";
    readonly error: string;
  }>;
}

export async function cleanupOldPlaywrightProjects(
  input: CleanupOldPlaywrightInput,
): Promise<CleanupOldPlaywrightReport> {
  const machinesDestroyed: string[] = [];
  const rowsDeleted: string[] = [];
  const failed: {
    projectId: string;
    stage: "destroy" | "deleteRow" | "lookup";
    error: string;
  }[] = [];

  for (const p of input.projects) {
    let assignment: { readonly machineId: string } | null;
    try {
      assignment = await input.assignments.getAssignment(p.id);
    } catch (err) {
      failed.push({
        projectId: p.id,
        stage: "lookup",
        error: errMessage(err),
      });
      continue;
    }

    if (assignment !== null) {
      try {
        await input.machines.destroyMachine(assignment.machineId, {
          force: true,
        });
        machinesDestroyed.push(p.id);
      } catch (err) {
        if (isAlreadyGone(err)) {
          machinesDestroyed.push(p.id);
        } else {
          failed.push({
            projectId: p.id,
            stage: "destroy",
            error: errMessage(err),
          });
          // Don't attempt the row delete: the Machine is still live,
          // and leaving the DB row matches the system's invariant
          // ("project row exists ⇒ Machine is allowed to exist").
          continue;
        }
      }
    }

    try {
      const removed = await input.rows.deleteProject(p.id);
      if (removed) rowsDeleted.push(p.id);
    } catch (err) {
      failed.push({
        projectId: p.id,
        stage: "deleteRow",
        error: errMessage(err),
      });
    }
  }

  return {
    inspected: input.projects.length,
    machinesDestroyed,
    rowsDeleted,
    failed,
  };
}

function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { status?: unknown };
  return rec.status === 404;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
