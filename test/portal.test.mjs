import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "oidc-portal-test-"));
const output = path.join(temporaryDirectory, "portal.mjs");
await build({ entryPoints: [path.resolve("system/portal/src/index.ts")], bundle: true, platform: "node", format: "esm", outfile: output });
const { HTML, allocateOpId, applyRateLimit, hashPassword, ipKey, route, validateInput, validateRedirectUrl } = await import(`${pathToFileURL(output).href}?${Date.now()}`);

class MockDatabase {
  counters = new Map();
  requests = new Map();
  users = [];

  prepare(sql) {
    const database = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes("INSERT INTO registry_rate_limits")) {
              const key = params.join("|");
              const count = (database.counters.get(key) ?? 0) + 1;
              database.counters.set(key, count);
              return { count };
            }
            if (sql.includes("SELECT count FROM registry_rate_limits")) return { count: database.counters.get(["ip", ...params].join("|")) ?? 0 };
            if (sql.includes("FROM registry_requests WHERE request_id")) return database.requests.get(params[0]) ?? null;
            return null;
          },
          async run() {
            if (sql.includes("SET count = CASE")) {
              const key = ["ip", ...params].join("|");
              database.counters.set(key, Math.max(0, (database.counters.get(key) ?? 0) - 1));
            } else if (sql.includes("INSERT INTO registry_requests")) {
              database.requests.set(params[0], { request_id: params[0], status: "pending", op_id: params[1], name: params[2], config_json: params[3], ip_key: params[4], clone_token_hash: params[5], created_at: params[6], url: null, error: null });
            } else if (sql.includes("INSERT INTO oidc_users")) {
              database.users.push({ op_id: params[0], username: params[1], password_hash: params[2], password_salt: params[3], iterations: params[4], claims_json: params[5] });
            } else if (sql.includes("UPDATE registry_requests SET status = 'failed'")) {
              const row = database.requests.get(params[0]);
              if (row) Object.assign(row, { status: "failed", error: "dispatch_failed", config_json: null });
            } else if (sql.includes("DELETE FROM oidc_users")) {
              database.users = database.users.filter((user) => user.op_id !== params[0]);
            }
            return { success: true };
          },
        };
      },
    };
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }
}

const features = { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true };
function createBody(clientType = "public") {
  return { name: "Demo OP", redirect_url: "https://client.example/callback", client_type: clientType, scopes: ["openid", "profile", "email"], features, users: [{ username: "alice", password: "correct-horse-battery" }] };
}

function createRequest(body) {
  return new Request("https://portal.example/api/apps", { method: "POST", headers: { host: "portal.example", origin: "https://portal.example", "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify(body) });
}

function env(DB) {
  return { DB, RATE_LIMIT_PER_IP_PER_DAY: "10", RATE_LIMIT_GLOBAL_PER_DAY: "50", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_DISPATCH_TOKEN: "token" };
}

test("the UI contains redirect URL, scopes, client type, feature, account, and CSV controls", () => {
  for (const marker of ["redirect-url", "client-type", "offline_access", "refresh-token", "add-user", "type=\"file\"", "username,password", "CSVプレビュー", "user-count"]) assert.match(HTML, new RegExp(marker));
});

test("the inline portal script is valid JavaScript", () => {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test("CSV parsing supports quoted fields and validates preview rows", () => {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const functions = script.slice(script.indexOf("function parseCsv"), script.indexOf("function renderCsvPreview"));
  const context = {};
  vm.runInNewContext(`${functions}; this.parseCsv = parseCsv; this.validateCsvRows = validateCsvRows;`, context);
  const rows = context.parseCsv('alice,"long,password"\r\nbob,password-123\n');
  assert.deepEqual(Array.from(rows, (row) => Array.from(row)), [["alice", "long,password"], ["bob", "password-123"]]);
  assert.deepEqual(Array.from(context.validateCsvRows(rows), ({ username, errors }) => ({ username, errors: Array.from(errors) })), [
    { username: "alice", errors: [] },
    { username: "bob", errors: [] },
  ]);
  const invalid = context.validateCsvRows(context.parseCsv('same,short\nsame,password-123'));
  assert.match(invalid[0].errors.join(" "), /8〜128/);
  assert.match(invalid[1].errors.join(" "), /重複/);
  assert.throws(() => context.parseCsv('alice,"unterminated'), /引用符/);
});

test("redirect URLs allow HTTPS and localhost HTTP but reject fragments and remote HTTP", () => {
  assert.equal(validateRedirectUrl("https://example.com/callback"), "https://example.com/callback");
  assert.equal(validateRedirectUrl("http://localhost:3000/callback"), "http://localhost:3000/callback");
  assert.equal(validateRedirectUrl("http://example.com/callback"), null);
  assert.equal(validateRedirectUrl("https://example.com/callback#fragment"), null);
});

test("input validation enforces selected scopes, feature consistency, unique users, and five-account limit", () => {
  assert.ok(validateInput(createBody()));
  assert.equal(validateInput({ ...createBody(), scopes: ["openid", "offline_access"], features: { ...features, "refresh-token": false } }), null);
  assert.equal(validateInput({ ...createBody(), scopes: ["openid", "unknown"] }), null);
  assert.equal(validateInput({ ...createBody(), users: Array.from({ length: 6 }, (_, index) => ({ username: `user${index}`, password: "password-123" })) }), null);
  assert.equal(validateInput({ ...createBody(), users: [{ username: "same", password: "password-123" }, { username: "same", password: "password-456" }] }), null);
});

test("IP keys retain IPv4 and aggregate IPv6 by canonical /64", () => {
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:0DB8:0012:0034:abcd::1"), "2001:db8:12:34::/64");
  assert.equal(ipKey("999.1.1.1"), "invalid");
});

test("per-IP rate limiting rejects the eleventh request", async () => {
  const DB = new MockDatabase();
  for (let index = 0; index < 10; index += 1) assert.equal(await applyRateLimit(env(DB), "203.0.113.7", "2026-07-23"), true);
  assert.equal(await applyRateLimit(env(DB), "203.0.113.7", "2026-07-23"), false);
});

test("password hashing uses salted SHA-256 and does not retain plaintext", async () => {
  const first = await hashPassword("password-123");
  const second = await hashPassword("password-123");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, "password-123");
  const expected = await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from(first.salt, "base64url"), Buffer.from("password-123")]));
  assert.equal(first.hash, Buffer.from(expected).toString("base64url"));
  assert.equal(first.iterations, 1);
});

test("public creation returns no secret and writes a hashed D1 user", async () => {
  const DB = new MockDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const response = await route(createRequest(createBody("public")), env(DB));
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.match(result.client_id, /^client_/);
    assert.equal("client_secret" in result, false);
    assert.equal(DB.requests.size, 1);
    assert.equal(DB.users.length, 1);
    assert.notEqual(DB.users[0].password_hash, "correct-horse-battery");
    assert.match(result.clone_token, /^[A-Za-z0-9_-]{30,}$/);
    const stored = [...DB.requests.values()][0];
    assert.match(stored.clone_token_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(stored.clone_token_hash, result.clone_token);
    const config = JSON.parse(stored.config_json);
    assert.equal(config.client_type, "public");
    assert.equal(config.redirect_url, "https://client.example/callback");
    assert.deepEqual(config.scopes, ["openid", "profile", "email"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("confidential creation returns a one-time client secret", async () => {
  const DB = new MockDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const response = await route(createRequest(createBody("confidential")), env(DB));
    const result = await response.json();
    assert.equal(response.status, 202);
    assert.match(result.client_secret, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(JSON.parse([...DB.requests.values()][0].config_json).client_secret, result.client_secret);
  } finally { globalThis.fetch = originalFetch; }
});

test("Origin is checked before D1 or dispatch", async () => {
  const response = await route(new Request("https://portal.example/api/apps", { method: "POST", headers: { host: "portal.example", origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(createBody()) }), { DB: { prepare() { throw new Error("must not access D1"); } } });
  assert.equal(response.status, 403);
});

test("allocated OP id is the Worker subdomain label and namespace key", () => {
  assert.match(allocateOpId(1784764800000), /^maronn-op-[a-z0-9]{10,16}$/);
});
