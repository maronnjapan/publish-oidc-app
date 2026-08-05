import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { INDEX_STATEMENTS, SCHEMA_STATEMENTS } from "../system/db/ddl.mjs";
import { applySchemaWith } from "../scripts/setup.mjs";
import { importModule } from "./support/build.mjs";

/**
 * The DDL in `system/db/ddl.mjs` creates the database; the Drizzle tables in
 * `system/db/schema.ts` are what the Workers query through. Nothing at runtime compares
 * them, so this does: a column added to one and not the other stops the build.
 */

const schema = await importModule("system/db/schema.ts");

function parseCreateTable(statement) {
  const match = statement.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)$/s);
  if (!match) return null;
  const [, name, inner] = match;
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of inner) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current.trim());

  const columns = new Map();
  let primaryKey = [];
  for (const part of parts) {
    const composite = part.match(/^PRIMARY KEY \((.*)\)$/);
    if (composite) {
      primaryKey = composite[1].split(",").map((column) => column.trim());
      continue;
    }
    const [columnName, type, ...rest] = part.split(/\s+/);
    const constraints = rest.join(" ");
    columns.set(columnName, {
      type,
      notNull: /NOT NULL/.test(constraints) || /PRIMARY KEY/.test(constraints),
      unique: /UNIQUE/.test(constraints),
    });
    if (/PRIMARY KEY/.test(constraints)) primaryKey = [columnName];
  }
  return { name, columns, primaryKey };
}

function parseCreateIndex(statement) {
  const match = statement.match(/^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \((.*)\)$/);
  return match ? { name: match[1], table: match[2], columns: match[3].split(",").map((c) => c.trim()) } : null;
}

const ddlTables = new Map(
  SCHEMA_STATEMENTS.map(parseCreateTable)
    .filter(Boolean)
    .map((table) => [table.name, table]),
);
const ddlIndexes = new Map(
  SCHEMA_STATEMENTS.map(parseCreateIndex)
    .filter(Boolean)
    .map((index) => [index.name, index]),
);

const drizzleTables = Object.values(schema)
  .filter((value) => value && typeof value === "object" && !Array.isArray(value))
  .map((value) => {
    try {
      return getTableConfig(value);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

test("the DDL declares exactly the tables the Drizzle schema describes", () => {
  assert.deepEqual(
    drizzleTables.map((table) => table.name).sort(),
    [...ddlTables.keys()].sort(),
  );
});

test("every Drizzle column exists in the DDL with the same type and nullability", () => {
  for (const table of drizzleTables) {
    const ddl = ddlTables.get(table.name);
    assert.ok(ddl, `${table.name} is missing from the DDL`);
    assert.deepEqual(
      table.columns.map((column) => column.name).sort(),
      [...ddl.columns.keys()].sort(),
      `${table.name} columns differ`,
    );
    for (const column of table.columns) {
      const declared = ddl.columns.get(column.name);
      const expectedType = column.getSQLType().toUpperCase();
      assert.equal(declared.type, expectedType, `${table.name}.${column.name} type differs`);
      assert.equal(
        column.notNull,
        declared.notNull,
        `${table.name}.${column.name} nullability differs`,
      );
      assert.equal(column.isUnique === true, declared.unique, `${table.name}.${column.name} uniqueness differs`);
    }
  }
});

test("primary keys match, single-column and composite alike", () => {
  for (const table of drizzleTables) {
    const ddl = ddlTables.get(table.name);
    const drizzleKey =
      table.primaryKeys.length > 0
        ? table.primaryKeys[0].columns.map((column) => column.name)
        : table.columns.filter((column) => column.primary).map((column) => column.name);
    assert.deepEqual(drizzleKey, ddl.primaryKey, `${table.name} primary key differs`);
  }
});

test("every declared index is created by the DDL", () => {
  const declared = drizzleTables.flatMap((table) =>
    table.indexes.map((index) => {
      const config = index.config;
      return {
        name: config.name,
        table: table.name,
        columns: config.columns.map((column) => column.name),
      };
    }),
  );
  assert.ok(declared.length > 0, "the schema declares no indexes at all");
  for (const index of declared) {
    const ddl = ddlIndexes.get(index.name);
    assert.ok(ddl, `index ${index.name} is missing from the DDL`);
    assert.equal(ddl.table, index.table);
    assert.deepEqual(ddl.columns, index.columns, `index ${index.name} columns differ`);
  }
});

/** `run(sql)` over a real SQLite database, shaped like the D1 REST response setup reads. */
function runner(database) {
  return async (sql) => ({ success: true, results: database.prepare(sql).all() });
}

test("setup upgrades a database created before registry_ops.expires_at existed", async () => {
  const database = new DatabaseSync(":memory:");
  // The shape those databases actually have: no expires_at, and live rows in it.
  database.exec(
    `CREATE TABLE registry_ops (op_id TEXT PRIMARY KEY, script_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL, url TEXT NOT NULL, client_id TEXT NOT NULL, client_type TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes_json TEXT NOT NULL, features_json TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`,
  );
  database.exec(
    `INSERT INTO registry_ops (op_id, script_name, name, url, client_id, client_type, redirect_uri, scopes_json, features_json, created_at, status)
     VALUES ('maronn-op-legacy1234', 'maronn-op-legacy1234', 'legacy', 'https://op.example', 'client_x', 'public', 'https://client.example/cb', '["openid"]', '{}', '2026-07-22T09:00:00.000Z', 'active')`,
  );

  await applySchemaWith(runner(database));

  const [row] = database.prepare("SELECT expires_at FROM registry_ops").all();
  assert.equal(row.expires_at, "2026-07-23T09:00:00.000Z", "an existing OP must get an expiry 24 hours after it was created");
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((entry) => entry.name);
  assert.ok(indexes.includes("idx_registry_ops_expiry"));
  // Applying it a second time must be a no-op rather than an error.
  await applySchemaWith(runner(database));
  assert.equal(database.prepare("SELECT count(*) AS n FROM registry_ops").get().n, 1);
});

test("the expiry index cannot be created before the column it indexes", () => {
  // This is why TABLE_STATEMENTS and INDEX_STATEMENTS are separate lists: run naively in one
  // pass, the index would hit a database whose registry_ops predates the column.
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE registry_ops (op_id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
  const index = INDEX_STATEMENTS.find((statement) => statement.includes("idx_registry_ops_expiry"));
  assert.throws(() => database.exec(index), /no such column: expires_at/);
});

test("the SQL in the deploy scripts still matches the schema", async () => {
  // scripts/deploy-op.mjs and scripts/update-request.mjs write to the shared D1 over the REST
  // API, so they hold SQL strings that no type checker sees. Preparing each one against the
  // real schema is what turns a renamed column into a failing test rather than a broken CI run.
  const database = new DatabaseSync(":memory:");
  for (const statement of SCHEMA_STATEMENTS) database.exec(statement);
  let prepared = 0;
  for (const file of ["scripts/deploy-op.mjs", "scripts/update-request.mjs"]) {
    const source = await readFile(file, "utf8");
    const statements = [...source.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?)`/g)].map((match) => match[1]);
    assert.ok(statements.length > 0, `${file} has no SQL to check`);
    for (const sql of statements) {
      assert.doesNotThrow(() => database.prepare(sql.replace(/\?\d+/g, "?")), `${file}: ${sql.slice(0, 60)}`);
      prepared += 1;
    }
  }
  assert.ok(prepared >= 4, "every write path in the deploy scripts should be covered");
});

test("the reaper's deletion order clears children before the ledger rows", () => {
  assert.deepEqual(
    schema.OP_SCOPED_TABLES.map((table) => getTableConfig(table).name),
    ["oidc_consent_grants", "oidc_consents", "oidc_records", "oidc_users", "registry_requests", "registry_ops"],
  );
  // Every one of them has to be reachable by op_id or the reaper cannot scope its delete.
  for (const table of schema.OP_SCOPED_TABLES) {
    assert.ok(
      getTableConfig(table).columns.some((column) => column.name === "op_id"),
      "an op-scoped table has no op_id column",
    );
  }
});
