/**
 * The shared D1 schema as idempotent DDL.
 *
 * `system/db/schema.ts` is what the Workers query through (Drizzle), but the database is
 * created by `scripts/setup.mjs` over the Cloudflare REST API — a plain Node script that
 * cannot import the TypeScript schema. So the DDL lives here, in JavaScript both sides can
 * read, and `test/db-schema.test.mjs` compares it column by column against the Drizzle
 * tables. Adding a column without updating both fails the build.
 *
 * Every statement is `IF NOT EXISTS`: setup runs against databases that already hold live
 * OP state, so it must never be a migration that assumes a starting point.
 *
 * Tables and indexes are separate lists because the order matters on an existing database.
 * `registry_ops.expires_at` was added after the first deployments, so a database created
 * back then still has to be ALTERed before an index on that column can be created — see
 * `ensureRegistryOpsExpiry()` in scripts/setup.mjs, which runs between the two lists.
 */
export const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS registry_requests (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, config_json TEXT, url TEXT, error TEXT, ip_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS registry_ops (op_id TEXT PRIMARY KEY, script_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL, url TEXT NOT NULL, client_id TEXT NOT NULL, client_type TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes_json TEXT NOT NULL, features_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE IF NOT EXISTS registry_rate_limits (scope TEXT NOT NULL, key TEXT NOT NULL, date_utc TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, key, date_utc))`,
  `CREATE TABLE IF NOT EXISTS oidc_users (op_id TEXT NOT NULL, username TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL, claims_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (op_id, username))`,
  `CREATE TABLE IF NOT EXISTS oidc_records (op_id TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL, value_json TEXT NOT NULL, expires_at INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (op_id, kind, record_key))`,
  `CREATE TABLE IF NOT EXISTS oidc_consents (op_id TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (op_id, subject, client_id))`,
  `CREATE TABLE IF NOT EXISTS oidc_consent_grants (op_id TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL, PRIMARY KEY (op_id, subject, client_id, grant_id))`,
];

export const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_registry_requests_status ON registry_requests (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_registry_ops_expiry ON registry_ops (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_oidc_records_expiry ON oidc_records (op_id, kind, expires_at)`,
];

/** The whole schema, for anything that just needs a database to exist (tests, mainly). */
export const SCHEMA_STATEMENTS = [...TABLE_STATEMENTS, ...INDEX_STATEMENTS];
