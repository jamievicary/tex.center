// Project-row storage primitives: insert, fetch by id, list by
// owner. The `projects` table is keyed by uuid and owned by a
// `users` row (cascade-on-delete). These helpers are the
// storage layer the future projects-dashboard + per-project
// routing will sit on; today every runtime codepath still uses
// the hardcoded literal `"default"` for the project id.

import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { projects } from './drizzle.js';
import type { ProjectRow } from './schema.js';
import type { DrizzleDb } from './users.js';

export interface CreateProjectInput {
  readonly ownerId: string;
  readonly name: string;
}

export async function createProject(
  db: DrizzleDb,
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const rows = await db
    .insert(projects)
    .values({
      id: randomUUID(),
      ownerId: input.ownerId,
      name: input.name,
    })
    .returning();
  const r = rows[0];
  if (!r) throw new Error('createProject: no row returned');
  return r;
}

export async function getProjectById(
  db: DrizzleDb,
  id: string,
): Promise<ProjectRow | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// Deletes the `projects` row by id. Cascades to
// `machine_assignments` via the FK in `drizzle.ts`. Returns true
// when a row was removed, false when no row existed (caller may
// treat both as success — idempotent).
export async function deleteProject(
  db: DrizzleDb,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(projects)
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return rows.length > 0;
}

// Returns every `projects.id` currently in the table, in an
// arbitrary order. Intended for the gold-side orphan-Machine sweep
// (`sweepOrphanedSidecarMachines`) which compares the set of
// `texcenter_project`-tagged Machines against the set of live
// project IDs; sorting would only be wasted work.
export async function listAllProjectIds(
  db: DrizzleDb,
): Promise<string[]> {
  const rows = await db.select({ id: projects.id }).from(projects);
  return rows.map((r) => r.id);
}

// Sorted by `created_at` ascending, then `id` ascending as a tie
// breaker so the result is deterministic when two projects share
// a `created_at` (PGlite's clock resolution can collide).
export async function listProjectsByOwnerId(
  db: DrizzleDb,
  ownerId: string,
): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(asc(projects.createdAt), asc(projects.id));
}
