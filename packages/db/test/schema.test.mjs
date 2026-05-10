// Schema sanity + SQL/spec sync test.
//
// Asserts that every table named in src/schema.ts appears in the
// initial migration with each declared column, and that each
// table has exactly one primary key. Drift between the spec and
// the SQL is the most plausible bug class for this layer until
// Drizzle wiring lands and removes the duplication.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

import { allTables, usersTable, sessionsTable, projectsTable, projectFilesTable, machineAssignmentsTable } from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, '..', 'src', 'migrations', '0001_initial.sql');
const sql = readFileSync(sqlPath, 'utf8');

// --- Per-spec invariants -----------------------------------------------

const expectedTables = [
    usersTable,
    sessionsTable,
    projectsTable,
    projectFilesTable,
    machineAssignmentsTable,
];

assert.deepEqual(
    allTables.map((t) => t.name),
    expectedTables.map((t) => t.name),
    'allTables must list every exported table in declaration order',
);

for (const table of allTables) {
    const names = table.columns.map((c) => c.name);
    assert.equal(
        new Set(names).size,
        names.length,
        `${table.name}: duplicate column names`,
    );

    const pks = table.columns.filter((c) => c.primaryKey);
    assert.equal(
        pks.length,
        1,
        `${table.name}: must have exactly one primary key column (got ${pks.length})`,
    );

    for (const col of table.columns) {
        if (col.references) {
            const target = allTables.find((t) => t.name === col.references.table);
            assert.ok(
                target,
                `${table.name}.${col.name} references unknown table ${col.references.table}`,
            );
            const targetCol = target.columns.find((c) => c.name === col.references.column);
            assert.ok(
                targetCol,
                `${table.name}.${col.name} references unknown column ${col.references.table}.${col.references.column}`,
            );
        }
    }
}

// --- SQL/spec sync ------------------------------------------------------

for (const table of allTables) {
    const createRe = new RegExp(`CREATE\\s+TABLE\\s+${table.name}\\b`, 'i');
    assert.ok(
        createRe.test(sql),
        `migration is missing CREATE TABLE for ${table.name}`,
    );

    for (const col of table.columns) {
        const colRe = new RegExp(`\\b${col.name}\\b\\s+${col.type}\\b`, 'i');
        assert.ok(
            colRe.test(sql),
            `migration is missing column ${table.name}.${col.name} of type ${col.type}`,
        );
    }
}

console.log(`db schema test: OK (${allTables.length} tables, ${allTables.reduce((n, t) => n + t.columns.length, 0)} columns)`);
