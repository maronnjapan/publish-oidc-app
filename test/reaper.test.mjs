import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "./support/d1-sqlite.mjs";
import { importModule } from "./support/build.mjs";

/**
 * The 24-hour reaper, against a real database.
 *
 * What matters here is what survives a run, so the assertions are about rows rather than
 * about which statements were issued: a query that deleted the wrong thing would still have
 * "issued a delete".
 */

const { runMaintenance } = await importModule("system/reaper/src/index.ts");

const NOW = new Date("2026-07-23T12:00:00Z");
const YESTERDAY = "2026-07-22T00:00:00.000Z";

function database() {
  const DB = new SqliteD1();
  return {
    DB,
    env: { DB, CF_API_TOKEN: "token", ACCOUNT_ID: "account" },
    addOp(opId, { expiresAt = YESTERDAY, status = "active", scriptName = opId } = {}) {
      DB.seed(
        `INSERT INTO registry_ops (op_id, script_name, name, url, client_id, client_type, redirect_uri, scopes_json, features_json, created_at, expires_at, status)
         VALUES (?, ?, 'demo', 'https://op.example', 'client_x', 'public', 'https://client.example/cb', '["openid"]', '{}', ?, ?, ?)`,
        opId,
        scriptName,
        YESTERDAY,
        expiresAt,
        status,
      );
      this.addData(opId);
    },
    addRequest(opId, { createdAt = YESTERDAY } = {}) {
      DB.seed(
        `INSERT INTO registry_requests (request_id, status, op_id, name, ip_key, created_at, updated_at)
         VALUES (?, 'pending', ?, 'demo', '203.0.113.7', ?, ?)`,
        `request-${opId}`,
        opId,
        createdAt,
        createdAt,
      );
    },
    /** One row in every op-scoped table, so a partial delete is visible. */
    addData(opId) {
      this.addRequest(opId);
      DB.seed(
        `INSERT INTO oidc_users (op_id, username, password_hash, password_salt, password_iterations, claims_json, created_at) VALUES (?, 'alice', 'h', 's', 1, '{}', ?)`,
        opId,
        YESTERDAY,
      );
      DB.seed(
        `INSERT INTO oidc_records (op_id, kind, record_key, value_json, expires_at, updated_at) VALUES (?, 'code:', 'k', '{}', NULL, ?)`,
        opId,
        YESTERDAY,
      );
      DB.seed(
        `INSERT INTO oidc_consents (op_id, subject, client_id, scopes_json, updated_at) VALUES (?, 'alice', 'client_x', '[]', ?)`,
        opId,
        YESTERDAY,
      );
      DB.seed(
        `INSERT INTO oidc_consent_grants (op_id, subject, client_id, grant_id) VALUES (?, 'alice', 'client_x', 'g')`,
        opId,
      );
    },
    remaining(opId) {
      return Object.fromEntries(
        ["registry_ops", "registry_requests", "oidc_users", "oidc_records", "oidc_consents", "oidc_consent_grants"].map(
          (table) => [table, DB.rows(`SELECT count(*) AS n FROM ${table} WHERE op_id = ?`, opId)[0].n],
        ),
      );
    },
  };
}

/** Stands in for the Cloudflare Worker-delete API and records what was asked for. */
async function withWorkerApi(respond, run) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const deleted = [];
  let attempt = 0;
  globalThis.fetch = async (url, init = {}) => {
    attempt += 1;
    assert.equal(init.method, "DELETE");
    const name = String(url).match(/workers\/scripts\/([^?]+)/)[1];
    const status = respond(attempt, name);
    if (status < 400) deleted.push(name);
    return new Response(null, { status });
  };
  console.error = () => {};
  try {
    return await run({ deleted, attempts: () => attempt });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

test("an expired OP Worker and every row keyed to it are deleted", async () => {
  const fixture = database();
  fixture.addOp("maronn-op-abc123defg");
  fixture.addOp("maronn-op-livezzzzzz", { expiresAt: "2026-07-24T00:00:00.000Z" });

  await withWorkerApi(
    () => 204,
    async ({ deleted }) => {
      await runMaintenance(fixture.env, NOW);
      assert.deepEqual(deleted, ["maronn-op-abc123defg"]);
    },
  );

  assert.deepEqual(fixture.remaining("maronn-op-abc123defg"), {
    registry_ops: 0,
    registry_requests: 0,
    oidc_users: 0,
    oidc_records: 0,
    oidc_consents: 0,
    oidc_consent_grants: 0,
  });
  // An OP whose time has not come is untouched.
  assert.equal(fixture.remaining("maronn-op-livezzzzzz").registry_ops, 1);
});

test("a stale request recovers an orphan Worker even without a ledger row", async () => {
  const fixture = database();
  fixture.addRequest("maronn-op-orphan1234");

  await withWorkerApi(
    () => 404,
    async ({ deleted }) => {
      await runMaintenance(fixture.env, NOW);
      assert.deepEqual(deleted, [], "a 404 is success, but nothing was actually removed");
    },
  );
  assert.equal(fixture.remaining("maronn-op-orphan1234").registry_requests, 0);
});

test("a request that is still young is left alone", async () => {
  const fixture = database();
  fixture.addRequest("maronn-op-recent1234", { createdAt: "2026-07-23T11:00:00.000Z" });
  await withWorkerApi(
    () => 204,
    async ({ attempts }) => {
      await runMaintenance(fixture.env, NOW);
      assert.equal(attempts(), 0);
    },
  );
  assert.equal(fixture.remaining("maronn-op-recent1234").registry_requests, 1);
});

test("a failed Worker deletion leaves the data for the next cron retry", async () => {
  const fixture = database();
  fixture.addOp("maronn-op-retry12345");

  await withWorkerApi(
    (attempt) => (attempt === 1 ? 503 : 204),
    async ({ attempts }) => {
      await runMaintenance(fixture.env, NOW);
      assert.equal(fixture.remaining("maronn-op-retry12345").registry_ops, 1);
      await runMaintenance(fixture.env, new Date("2026-07-23T12:15:00Z"));
      assert.equal(fixture.remaining("maronn-op-retry12345").registry_ops, 0);
      assert.equal(attempts(), 2);
    },
  );
});

test("the reaper refuses to delete a system Worker even if a ledger row is malformed", async () => {
  const fixture = database();
  fixture.addOp("maronn-op-abc123defg", { scriptName: "maronn-oidc-portal" });

  await withWorkerApi(
    () => 204,
    async ({ attempts }) => {
      await runMaintenance(fixture.env, NOW);
      assert.equal(attempts(), 0, "no delete may be attempted for a name that is not an OP id");
    },
  );
  assert.equal(fixture.remaining("maronn-op-abc123defg").registry_ops, 1);
});

test("rate-limit counters older than a week are cleared, recent ones kept", async () => {
  const fixture = database();
  fixture.DB.seed(`INSERT INTO registry_rate_limits (scope, key, date_utc, count) VALUES ('ip', 'a', '2026-07-01', 3)`);
  fixture.DB.seed(`INSERT INTO registry_rate_limits (scope, key, date_utc, count) VALUES ('ip', 'b', '2026-07-22', 4)`);

  await withWorkerApi(
    () => 204,
    () => runMaintenance(fixture.env, NOW),
  );
  assert.deepEqual(
    fixture.DB.rows("SELECT key FROM registry_rate_limits ORDER BY key").map((row) => row.key),
    ["b"],
  );
});
