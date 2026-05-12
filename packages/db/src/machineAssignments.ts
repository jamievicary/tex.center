// Storage primitives for the project↔Fly Machine mapping.
//
// The `machine_assignments` table is keyed by `project_id` (one
// Machine per project for now); rows are minted on first WS
// upgrade for a project and refreshed every time the upstream
// resolver consults Fly's Machines API. `state` is a cached copy
// of the Machine's lifecycle state so the resolver can short-
// circuit a `getMachine` call when the cache is fresh.

import { eq } from 'drizzle-orm';

import { machineAssignments } from './drizzle.js';
import type { MachineAssignmentRow } from './schema.js';
import type { DrizzleDb } from './users.js';

export interface UpsertMachineAssignmentInput {
  readonly projectId: string;
  readonly machineId: string;
  readonly region: string;
  readonly state: MachineAssignmentRow['state'];
}

export async function upsertMachineAssignment(
  db: DrizzleDb,
  input: UpsertMachineAssignmentInput,
): Promise<MachineAssignmentRow> {
  const now = new Date();
  const rows = await db
    .insert(machineAssignments)
    .values({
      projectId: input.projectId,
      machineId: input.machineId,
      region: input.region,
      state: input.state,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: machineAssignments.projectId,
      set: {
        machineId: input.machineId,
        region: input.region,
        state: input.state,
        lastSeenAt: now,
      },
    })
    .returning();
  const r = rows[0];
  if (!r) throw new Error('upsertMachineAssignment: no row returned');
  return r;
}

export async function getMachineAssignmentByProjectId(
  db: DrizzleDb,
  projectId: string,
): Promise<MachineAssignmentRow | null> {
  const rows = await db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateMachineAssignmentState(
  db: DrizzleDb,
  projectId: string,
  state: MachineAssignmentRow['state'],
): Promise<MachineAssignmentRow | null> {
  const rows = await db
    .update(machineAssignments)
    .set({ state, lastSeenAt: new Date() })
    .where(eq(machineAssignments.projectId, projectId))
    .returning();
  return rows[0] ?? null;
}

export async function deleteMachineAssignment(
  db: DrizzleDb,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(machineAssignments)
    .where(eq(machineAssignments.projectId, projectId))
    .returning({ projectId: machineAssignments.projectId });
  return rows.length > 0;
}
