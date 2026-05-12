// Drizzle table builders for the tex.center persistence schema.
//
// The TableSpec entries in ./schema.ts remain the source of truth
// for the SQL DDL (asserted by the schema test against
// migrations/0001_initial.sql). The Drizzle tables here drive the
// typed query layer; a paired test asserts the two views agree
// column-for-column so they can't drift.

import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  googleSub: text('google_sub').notNull().unique(),
  displayName: text('display_name'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: ts('created_at'),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => ({
    ownerIdIdx: index('projects_owner_id_idx').on(t.ownerId),
  }),
);

export const projectFiles = pgTable(
  'project_files',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    blobKey: text('blob_key').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => ({
    projectPathUq: uniqueIndex('project_files_project_id_path_uq').on(t.projectId, t.path),
  }),
);

export const machineAssignments = pgTable('machine_assignments', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  machineId: text('machine_id').notNull(),
  region: text('region').notNull(),
  state: text('state').$type<'starting' | 'running' | 'stopped'>().notNull(),
  lastSeenAt: ts('last_seen_at'),
  createdAt: ts('created_at'),
});

export const schema = {
  users,
  sessions,
  projects,
  projectFiles,
  machineAssignments,
};

export type Schema = typeof schema;
