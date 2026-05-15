// Entity types and table specifications for tex.center persistence.
//
// This module is the single source of truth for what's stored in
// Postgres. The TypeScript types describe the shape callers see at
// runtime; the `tables` const describes the columns at the SQL
// level (column name, SQL type, nullability, primary-key-ness).
//
// SQL DDL lives in src/migrations/. Keep the two in sync; the
// schema test asserts every table named here appears in the
// initial migration with each declared column.

export type ColumnType =
  | 'uuid'
  | 'text'
  | 'bytea'
  | 'bigint'
  | 'integer'
  | 'boolean'
  | 'timestamptz'
  | 'jsonb';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  readonly primaryKey?: boolean;
  readonly references?: { readonly table: string; readonly column: string };
}

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
}

// --- Entity row types ---------------------------------------------------

export interface UserRow {
  id: string;            // uuid
  email: string;         // allowlisted; uniqueness enforced by `google_sub`, not `email`
  googleSub: string;     // OAuth subject identifier
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRow {
  id: string;            // uuid; opaque cookie id
  userId: string;        // -> users.id
  expiresAt: Date;
  createdAt: Date;
}

export interface ProjectRow {
  id: string;            // uuid
  ownerId: string;       // -> users.id
  name: string;
  // M15 Step D: optional seed for `main.tex` consulted by the
  // sidecar on first hydration when no persisted blob exists.
  // `null` means "use the canonical `MAIN_DOC_HELLO_WORLD`".
  seedDoc: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectFileRow {
  id: string;            // uuid
  projectId: string;     // -> projects.id
  path: string;          // POSIX path within the project, e.g. "main.tex"
  size: number;          // bytes (bigint in SQL; safe-integer in JS)
  blobKey: string;       // Tigris/S3 object key
  contentHash: string;   // sha256 hex
  createdAt: Date;
  updatedAt: Date;
}

export interface MachineAssignmentRow {
  projectId: string;     // -> projects.id; PK (one machine per project)
  machineId: string;     // Fly Machine id
  region: string;        // Fly region code
  state: 'starting' | 'running' | 'stopped';
  lastSeenAt: Date;
  createdAt: Date;
}

// --- Table specs -------------------------------------------------------
//
// Lower-case snake_case column names match the SQL exactly. The
// runtime types above use camelCase; the mapping lives in the
// query layer (Drizzle, in a future slice).

const c = (
  name: string,
  type: ColumnType,
  opts: Partial<Omit<ColumnSpec, 'name' | 'type'>> = {},
): ColumnSpec => ({
  name,
  type,
  nullable: opts.nullable ?? false,
  ...(opts.primaryKey !== undefined ? { primaryKey: opts.primaryKey } : {}),
  ...(opts.references !== undefined ? { references: opts.references } : {}),
});

export const usersTable: TableSpec = {
  name: 'users',
  columns: [
    c('id', 'uuid', { primaryKey: true }),
    c('email', 'text'),
    c('google_sub', 'text'),
    c('display_name', 'text', { nullable: true }),
    c('created_at', 'timestamptz'),
    c('updated_at', 'timestamptz'),
  ],
};

export const sessionsTable: TableSpec = {
  name: 'sessions',
  columns: [
    c('id', 'uuid', { primaryKey: true }),
    c('user_id', 'uuid', { references: { table: 'users', column: 'id' } }),
    c('expires_at', 'timestamptz'),
    c('created_at', 'timestamptz'),
  ],
};

export const projectsTable: TableSpec = {
  name: 'projects',
  columns: [
    c('id', 'uuid', { primaryKey: true }),
    c('owner_id', 'uuid', { references: { table: 'users', column: 'id' } }),
    c('name', 'text'),
    c('seed_doc', 'text', { nullable: true }),
    c('created_at', 'timestamptz'),
    c('updated_at', 'timestamptz'),
  ],
};

export const projectFilesTable: TableSpec = {
  name: 'project_files',
  columns: [
    c('id', 'uuid', { primaryKey: true }),
    c('project_id', 'uuid', { references: { table: 'projects', column: 'id' } }),
    c('path', 'text'),
    c('size', 'bigint'),
    c('blob_key', 'text'),
    c('content_hash', 'text'),
    c('created_at', 'timestamptz'),
    c('updated_at', 'timestamptz'),
  ],
};

export const machineAssignmentsTable: TableSpec = {
  name: 'machine_assignments',
  columns: [
    c('project_id', 'uuid', {
      primaryKey: true,
      references: { table: 'projects', column: 'id' },
    }),
    c('machine_id', 'text'),
    c('region', 'text'),
    c('state', 'text'),
    c('last_seen_at', 'timestamptz'),
    c('created_at', 'timestamptz'),
  ],
};

export const allTables: readonly TableSpec[] = [
  usersTable,
  sessionsTable,
  projectsTable,
  projectFilesTable,
  machineAssignmentsTable,
];
