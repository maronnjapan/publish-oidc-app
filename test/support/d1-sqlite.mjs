import { DatabaseSync } from "node:sqlite";
import { SCHEMA_STATEMENTS } from "../../system/db/ddl.mjs";

/**
 * A real SQLite database behind the D1 interface, for tests.
 *
 * The portal and the reaper reach D1 through Drizzle now, so a test double that recognised
 * statements by matching substrings of hand-written SQL would be asserting against a query
 * builder's output — it would pass for SQL that SQLite rejects. This runs the generated SQL
 * against the schema `scripts/setup.mjs` actually creates instead, so a broken query fails
 * the test the way it would fail in production.
 */

/** node:sqlite accepts a narrower set of values than D1's binder does. */
function toSqliteValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class SqliteD1Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new SqliteD1Statement(this.database, this.sql, params.map(toSqliteValue));
  }

  #rows() {
    return this.database.prepare(this.sql).all(...this.params);
  }

  async first(column) {
    const row = this.#rows()[0] ?? null;
    if (column === undefined) return row;
    return row === null ? null : (row[column] ?? null);
  }

  async all() {
    return { success: true, results: this.#rows(), meta: {} };
  }

  /** D1 returns positional arrays here; SQLite gives objects, whose key order is column order. */
  async raw() {
    return this.#rows().map((row) => Object.values(row));
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  /**
   * What a batch entry produces. `all()` covers both cases: a statement with RETURNING hands
   * back its rows, and one without hands back an empty list.
   */
  execute() {
    return { success: true, results: this.#rows(), meta: {} };
  }
}

export class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    for (const statement of SCHEMA_STATEMENTS) this.database.exec(statement);
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  /** D1 runs a batch as one transaction, so a failure part way through rolls the whole thing back. */
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Straight SQL, for arranging a test's starting state without going through Drizzle. */
  seed(sql, ...params) {
    this.database.prepare(sql).run(...params.map(toSqliteValue));
  }

  rows(sql, ...params) {
    return this.database.prepare(sql).all(...params.map(toSqliteValue));
  }

  count(table) {
    return Number(this.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  }
}
