#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT, apiRequest, requireEnv } from "./lib.mjs";

const execFile = promisify(execFileCallback);
const DATABASE_NAME = "maronn-oidc-shared-d1";
const COMPATIBILITY_DATE = "2026-07-01";

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS registry_requests (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, config_json TEXT, url TEXT, error TEXT, ip_key TEXT NOT NULL, clone_token_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_registry_requests_status ON registry_requests (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS registry_ops (op_id TEXT PRIMARY KEY, script_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL, url TEXT NOT NULL, client_id TEXT NOT NULL, client_type TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes_json TEXT NOT NULL, features_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE IF NOT EXISTS registry_rate_limits (scope TEXT NOT NULL, key TEXT NOT NULL, date_utc TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, key, date_utc))`,
  `CREATE TABLE IF NOT EXISTS oidc_users (op_id TEXT NOT NULL, username TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL, claims_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (op_id, username))`,
  `CREATE TABLE IF NOT EXISTS oidc_records (op_id TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL, value_json TEXT NOT NULL, expires_at INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (op_id, kind, record_key))`,
  `CREATE INDEX IF NOT EXISTS idx_oidc_records_expiry ON oidc_records (op_id, kind, expires_at)`,
  `CREATE TABLE IF NOT EXISTS oidc_consents (op_id TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (op_id, subject, client_id))`,
  `CREATE TABLE IF NOT EXISTS oidc_consent_grants (op_id TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL, PRIMARY KEY (op_id, subject, client_id, grant_id))`,
];

function baseUrl(accountId, suffix) { return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${suffix}`; }

async function existingInfra() { try { return JSON.parse(await readFile(path.join(ROOT, "infra.json"), "utf8")); } catch { return {}; } }

async function githubRepository(existing) {
  if (process.env.GITHUB_REPOSITORY?.includes("/")) { const [github_owner, github_repo] = process.env.GITHUB_REPOSITORY.split("/", 2); return { github_owner, github_repo }; }
  if (process.env.GITHUB_OWNER && process.env.GITHUB_REPO) return { github_owner: process.env.GITHUB_OWNER, github_repo: process.env.GITHUB_REPO };
  if (existing.github_owner && existing.github_repo) return { github_owner: existing.github_owner, github_repo: existing.github_repo };
  try {
    const { stdout } = await execFile("git", ["config", "--get", "remote.origin.url"], { cwd: ROOT });
    const match = stdout.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return { github_owner: match[1], github_repo: match[2] };
  } catch { /* use the explicit error below */ }
  throw new Error("set GITHUB_REPOSITORY or GITHUB_OWNER and GITHUB_REPO");
}

async function ensureD1(accountId, token) {
  const list = await apiRequest(baseUrl(accountId, `/d1/database?name=${encodeURIComponent(DATABASE_NAME)}&per_page=100`), token);
  let database = Array.isArray(list.result) ? list.result.find((item) => item.name === DATABASE_NAME) : undefined;
  if (!database) database = (await apiRequest(baseUrl(accountId, "/d1/database"), token, { method: "POST", body: JSON.stringify({ name: DATABASE_NAME }) })).result;
  if (!database?.uuid) throw new Error("D1 API did not return a database uuid");
  return database.uuid;
}

async function applySchema(accountId, token, databaseId) {
  for (const sql of SCHEMA_STATEMENTS) {
    const { result } = await apiRequest(baseUrl(accountId, `/d1/database/${encodeURIComponent(databaseId)}/query`), token, { method: "POST", body: JSON.stringify({ sql, params: [] }) });
    const first = Array.isArray(result) ? result[0] : result;
    if (!first?.success) throw new Error(`D1 schema statement failed: ${sql.slice(0, 60)}`);
  }
  await ensureRegistryOpsExpiry(accountId, token, databaseId);
  await ensureRegistryRequestsCloneToken(accountId, token, databaseId);
}

async function runD1Statement(accountId, token, databaseId, sql, params = []) {
  const { result } = await apiRequest(baseUrl(accountId, `/d1/database/${encodeURIComponent(databaseId)}/query`), token, { method: "POST", body: JSON.stringify({ sql, params }) });
  const first = Array.isArray(result) ? result[0] : result;
  if (!first?.success) throw new Error(`D1 schema statement failed: ${sql.slice(0, 60)}`);
  return first;
}

export async function ensureRegistryOpsExpiry(accountId, token, databaseId) {
  const tableInfo = await runD1Statement(accountId, token, databaseId, "PRAGMA table_info(registry_ops)");
  const columns = new Set((Array.isArray(tableInfo.results) ? tableInfo.results : []).map((row) => row.name));
  if (!columns.has("expires_at")) {
    await runD1Statement(accountId, token, databaseId, "ALTER TABLE registry_ops ADD COLUMN expires_at TEXT");
  }
  await runD1Statement(
    accountId,
    token,
    databaseId,
    `UPDATE registry_ops
     SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours')
     WHERE expires_at IS NULL`,
  );
  await runD1Statement(
    accountId,
    token,
    databaseId,
    "CREATE INDEX IF NOT EXISTS idx_registry_ops_expiry ON registry_ops (status, expires_at)",
  );
}

/** Adds the clone token column to databases created before `git clone` support existed. */
export async function ensureRegistryRequestsCloneToken(accountId, token, databaseId) {
  const tableInfo = await runD1Statement(accountId, token, databaseId, "PRAGMA table_info(registry_requests)");
  const columns = new Set((Array.isArray(tableInfo.results) ? tableInfo.results : []).map((row) => row.name));
  if (!columns.has("clone_token_hash")) {
    await runD1Statement(accountId, token, databaseId, "ALTER TABLE registry_requests ADD COLUMN clone_token_hash TEXT");
  }
}

async function main() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const existing = await existingInfra();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? existing.account_id;
  if (!accountId) throw new Error("set CLOUDFLARE_ACCOUNT_ID");
  const github = await githubRepository(existing);
  const databaseId = await ensureD1(accountId, token);
  await applySchema(accountId, token, databaseId);
  const { result } = await apiRequest(baseUrl(accountId, "/workers/subdomain"), token);
  if (typeof result?.subdomain !== "string" || !result.subdomain) throw new Error("Cloudflare account has no workers.dev subdomain");
  const infra = { account_id: accountId, workers_dev_subdomain: result.subdomain, d1_database_id: databaseId, compatibility_date: existing.compatibility_date || COMPATIBILITY_DATE, ...github };
  const target = path.join(ROOT, "infra.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(infra, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  process.stdout.write("Shared D1 and schema are ready. Review and commit infra.json.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
