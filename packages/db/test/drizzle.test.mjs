// Drizzle ↔ TableSpec cross-check.
//
// The TableSpec entries in src/schema.ts drive the SQL migration
// test (schema.test.mjs); the Drizzle pgTable builders in
// src/drizzle.ts drive the typed query layer. This test asserts
// that for every spec table and column, the corresponding Drizzle
// table declares the same column with the matching SQL type,
// nullability, primary-key flag, and foreign-key target. If the
// two views drift, queries will compile against a schema the
// database doesn't have.

import { strict as assert } from 'node:assert';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { allTables } from '../src/schema.ts';
import { schema } from '../src/drizzle.ts';

// Camel/snake mapping that mirrors the convention used in
// drizzle.ts (snake_case in SQL, camelCase as TS keys). The
// TableSpec carries the snake_case name; the Drizzle table is
// keyed by camelCase. Build the lookup from the Drizzle config so
// the test isn't another place that has to know the mapping.
const drizzleByName = {};
for (const [, table] of Object.entries(schema)) {
    const cfg = getTableConfig(table);
    drizzleByName[cfg.name] = cfg;
}

const SQL_TYPE_BY_SPEC_TYPE = {
    uuid: 'uuid',
    text: 'text',
    bytea: 'bytea',
    bigint: 'bigint',
    integer: 'integer',
    boolean: 'boolean',
    timestamptz: 'timestamp with time zone',
    jsonb: 'jsonb',
};

assert.deepEqual(
    Object.keys(drizzleByName).sort(),
    allTables.map((t) => t.name).sort(),
    'Drizzle schema and allTables must declare the same set of tables',
);

for (const spec of allTables) {
    const cfg = drizzleByName[spec.name];
    assert.ok(cfg, `no Drizzle table for spec table ${spec.name}`);

    const drizzleColsByName = new Map(cfg.columns.map((c) => [c.name, c]));

    for (const col of spec.columns) {
        const dcol = drizzleColsByName.get(col.name);
        assert.ok(
            dcol,
            `Drizzle table ${spec.name} is missing column ${col.name}`,
        );

        const expectedSqlType = SQL_TYPE_BY_SPEC_TYPE[col.type];
        assert.equal(
            dcol.getSQLType().toLowerCase(),
            expectedSqlType,
            `${spec.name}.${col.name}: SQL type ${dcol.getSQLType()} != expected ${expectedSqlType}`,
        );

        assert.equal(
            dcol.notNull,
            !col.nullable,
            `${spec.name}.${col.name}: notNull mismatch (drizzle=${dcol.notNull}, spec.nullable=${col.nullable})`,
        );

        assert.equal(
            dcol.primary,
            !!col.primaryKey,
            `${spec.name}.${col.name}: primary mismatch (drizzle=${dcol.primary}, spec=${!!col.primaryKey})`,
        );
    }

    // Foreign keys: every spec FK must appear in cfg.foreignKeys with
    // the same source/target column names.
    for (const col of spec.columns) {
        if (!col.references) continue;
        const fkMatch = cfg.foreignKeys.find((fk) => {
            const ref = fk.reference();
            return (
                ref.columns.length === 1 &&
                ref.columns[0].name === col.name &&
                ref.foreignTable[Symbol.for('drizzle:Name')] === col.references.table &&
                ref.foreignColumns.length === 1 &&
                ref.foreignColumns[0].name === col.references.column
            );
        });
        assert.ok(
            fkMatch,
            `${spec.name}.${col.name}: missing FK to ${col.references.table}.${col.references.column}`,
        );
    }
}

console.log(
    `db drizzle test: OK (${allTables.length} tables, ` +
        `${allTables.reduce((n, t) => n + t.columns.length, 0)} columns)`,
);
