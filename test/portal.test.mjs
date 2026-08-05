import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "./support/d1-sqlite.mjs";
import { importModules, importPortal } from "./support/build.mjs";

/**
 * The portal Worker over HTTP, against a real SQLite database behind the D1 interface.
 * Every assertion here is about what a caller sees and what ends up in the database, so the
 * routing, validation and persistence layers are all exercised as they are deployed.
 */

const { default: app } = await importPortal();
const { credentials, db, ip, rateLimit } = await importModules({
  credentials: "system/portal/src/server/services/credentials.ts",
  db: "system/db/client.ts",
  ip: "system/portal/src/server/ip.ts",
  rateLimit: "system/portal/src/server/services/rate-limit.ts",
});
const { ipKey } = ip;
const { createDb } = db;

const features = { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true };

function createBody(clientType = "public", overrides = {}) {
  return {
    name: "Demo OP",
    redirect_url: "https://client.example/callback",
    client_type: clientType,
    scopes: ["openid", "profile", "email"],
    features,
    users: [{ username: "alice", password: "correct-horse-battery" }],
    ...overrides,
  };
}

function createRequest(body, headers = {}) {
  return new Request("https://portal.example/api/apps", {
    method: "POST",
    headers: {
      host: "portal.example",
      origin: "https://portal.example",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function environment(DB = new SqliteD1()) {
  return {
    DB,
    RATE_LIMIT_PER_IP_PER_DAY: "10",
    RATE_LIMIT_GLOBAL_PER_DAY: "50",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_DISPATCH_TOKEN: "token",
  };
}

/** Runs a request with the GitHub dispatch stubbed out, since no test may reach the network. */
async function withDispatch(status, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the daily quota is reported per IP and starts full", async () => {
  const env = environment();
  const response = await app.fetch(
    new Request("https://portal.example/api/quota", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { limit: 10, used: 0, remaining: 10 });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a public creation returns no secret and writes a hashed account to D1", async () => {
  const env = environment();
  const result = await withDispatch(204, async (calls) => {
    const response = await app.fetch(createRequest(createBody("public")), env);
    assert.equal(response.status, 202);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /actions\/workflows\/generate-op\.yml\/dispatches$/);
    return response.json();
  });

  assert.match(result.client_id, /^client_/);
  assert.equal("client_secret" in result, false);

  const [request] = env.DB.rows("SELECT * FROM registry_requests");
  assert.equal(request.status, "pending");
  assert.match(request.op_id, /^maronn-op-[a-z0-9]{10,16}$/);
  assert.equal(request.ip_key, "203.0.113.7");
  const config = JSON.parse(request.config_json);
  assert.equal(config.client_type, "public");
  assert.equal(config.redirect_url, "https://client.example/callback");
  assert.deepEqual(config.scopes, ["openid", "profile", "email"]);

  const [user] = env.DB.rows("SELECT * FROM oidc_users");
  assert.equal(user.username, "alice");
  assert.equal(user.op_id, request.op_id);
  assert.notEqual(user.password_hash, "correct-horse-battery");
  assert.equal(user.password_iterations, 1);
});

test("a confidential creation returns a one-time client secret that CI can read back", async () => {
  const env = environment();
  const result = await withDispatch(204, async () => (await app.fetch(createRequest(createBody("confidential")), env)).json());
  assert.match(result.client_secret, /^[A-Za-z0-9_-]{40,}$/);
  const [request] = env.DB.rows("SELECT config_json FROM registry_requests");
  assert.equal(JSON.parse(request.config_json).client_secret, result.client_secret);
});

test("usernames are trimmed before storage so padded input is accepted", async () => {
  const env = environment();
  await withDispatch(204, () =>
    app.fetch(createRequest(createBody("public", { users: [{ username: "  alice  ", password: "correct-horse-battery" }] })), env),
  );
  assert.equal(env.DB.rows("SELECT username FROM oidc_users")[0].username, "alice");
});

test("the creation status the browser polls exposes no configuration", async () => {
  const env = environment();
  const created = await withDispatch(204, async () => (await app.fetch(createRequest(createBody()), env)).json());
  const response = await app.fetch(new Request(`https://portal.example/api/requests/${created.request_id}`), env);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(Object.keys(status).sort(), ["created_at", "error", "op_id", "request_id", "status", "url"]);
  assert.equal(status.status, "pending");
});

test("an unknown or malformed request id is a 404, not a database lookup", async () => {
  const env = environment();
  for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
    const response = await app.fetch(new Request(`https://portal.example/api/requests/${id}`), env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  }
});

test("rejected creations report the offending field instead of a generic message", async () => {
  const cases = [
    [createBody("public", { redirect_url: "http://example.com/callback" }), /redirect URL/],
    [createBody("native"), /client type/],
    [createBody("public", { scopes: ["openid", "unknown"] }), /scope "unknown"/],
    [createBody("public", { scopes: ["openid", "offline_access"], features: { ...features, "refresh-token": false } }), /offline_access/],
    [createBody("public", { users: [{ username: "たろう", password: "password-123" }] }), /user 1 username/],
    [createBody("public", { users: [{ username: "alice", password: "short" }] }), /user 1 password/],
    [
      createBody("public", {
        users: [
          { username: "same", password: "password-123" },
          { username: "same", password: "password-456" },
        ],
      }),
      /registered twice/,
    ],
    [createBody("public", { name: "line\nbreak" }), /display name/],
  ];
  for (const [body, expected] of cases) {
    const env = environment();
    const response = await app.fetch(createRequest(body), env);
    const result = await response.json();
    assert.equal(response.status, 400, result.message);
    assert.equal(result.error, "invalid_input");
    assert.match(result.message, expected);
    assert.equal(env.DB.count("registry_requests"), 0, "an invalid body must not reach the database");
    assert.equal(env.DB.count("registry_rate_limits"), 0, "an invalid body must not spend the caller's quota");
  }
});

test("Origin is checked before anything is read or written", async () => {
  const env = environment();
  const response = await app.fetch(
    new Request("https://portal.example/api/apps", {
      method: "POST",
      headers: { host: "portal.example", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(createBody()),
    }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_mismatch");
  assert.equal(env.DB.count("registry_requests"), 0);
});

test("an oversized body is refused without being parsed", async () => {
  const env = environment();
  const response = await app.fetch(createRequest(createBody(), { "content-length": "20001" }), env);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "payload_too_large");
});

test("a body that is not JSON is a 400 that names the problem", async () => {
  const env = environment();
  const response = await app.fetch(
    new Request("https://portal.example/api/apps", {
      method: "POST",
      headers: { host: "portal.example", origin: "https://portal.example", "content-type": "application/json" },
      body: "{",
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /valid JSON/);
});

test("a creation that cannot start CI is rolled back rather than left pending", async () => {
  const env = environment();
  const response = await withDispatch(500, () => app.fetch(createRequest(createBody()), env));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "dispatch_failed");
  const [request] = env.DB.rows("SELECT status, error, config_json FROM registry_requests");
  assert.equal(request.status, "failed");
  assert.equal(request.error, "dispatch_failed");
  assert.equal(request.config_json, null, "the client secret must not survive a failed dispatch");
  assert.equal(env.DB.count("oidc_users"), 0);
});

test("per-IP rate limiting rejects the eleventh creation and says when to come back", async () => {
  const env = environment();
  await withDispatch(204, async () => {
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await app.fetch(createRequest(createBody()), env)).status, 202);
    }
    const response = await app.fetch(createRequest(createBody()), env);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, "rate_limited");
    assert.match(response.headers.get("retry-after"), /^\d+$/);
  });
});

test("the global limit rejecting a request gives the caller's own quota back", async () => {
  const DB = new SqliteD1();
  const env = { ...environment(DB), RATE_LIMIT_GLOBAL_PER_DAY: "1" };
  const db = createDb(DB);
  const date = rateLimit.utcDate();
  assert.equal(await rateLimit.applyRateLimit(db, env, "203.0.113.7", date), true);
  assert.equal(await rateLimit.applyRateLimit(db, env, "198.51.100.9", date), false);
  const rows = Object.fromEntries(
    DB.rows("SELECT scope, key, count FROM registry_rate_limits").map((row) => [`${row.scope}:${row.key}`, row.count]),
  );
  assert.equal(rows["ip:198.51.100.9"], 0, "the rejected caller keeps its quota");
  assert.equal(rows["ip:203.0.113.7"], 1);
  assert.equal(rows["global:*"], 2);
});

test("IP keys retain IPv4 and aggregate IPv6 by canonical /64", () => {
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:0DB8:0012:0034:abcd::1"), "2001:db8:12:34::/64");
  assert.equal(ipKey("999.1.1.1"), "invalid");
  assert.equal(ipKey(null), "unknown");
});

test("the retry-after lands on the next UTC midnight", () => {
  assert.equal(rateLimit.retryAfterUtcMidnight(new Date("2026-07-23T23:59:00Z")), "60");
  assert.equal(rateLimit.retryAfterUtcMidnight(new Date("2026-07-23T00:00:00Z")), String(24 * 60 * 60));
});

test("password hashing uses salted SHA-256 and does not retain plaintext", async () => {
  const first = await credentials.hashPassword("password-123");
  const second = await credentials.hashPassword("password-123");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, "password-123");
  const expected = await crypto.subtle.digest(
    "SHA-256",
    Buffer.concat([Buffer.from(first.salt, "base64url"), Buffer.from("password-123")]),
  );
  assert.equal(first.hash, Buffer.from(expected).toString("base64url"));
  assert.equal(first.iterations, 1);
});

test("an allocated OP id is a valid Worker subdomain label and namespace key", () => {
  for (let index = 0; index < 50; index += 1) {
    assert.match(credentials.allocateOpId(1784764800000 + index * 1000), /^maronn-op-[a-z0-9]{10,16}$/);
  }
});

test("opt-in selections are validated against their catalogs and reach the deployment config", async () => {
  const env = environment();
  await withDispatch(204, async () => {
    const response = await app.fetch(
      createRequest(createBody("public", { experimental: { par: { required: true } }, optional: { "transaction-binding": {} } })),
      env,
    );
    assert.equal(response.status, 202);
  });
  const config = JSON.parse(env.DB.rows("SELECT config_json FROM registry_requests")[0].config_json);
  assert.deepEqual(config.experimental, { par: { required: true } });
  assert.deepEqual(config.optional, { "transaction-binding": {} });
});

test("an id may not cross between the optional and experimental groups", async () => {
  const cases = [
    [{ optional: { par: {} } }, /optional feature "par"/],
    [{ experimental: { "transaction-binding": {} } }, /experimental feature "transaction-binding"/],
    [{ experimental: { par: { nope: true } } }, /experimental option "par\.nope"/],
    [{ experimental: { par: { required: "yes" } } }, /must be true or false/],
    [{ experimental: [] }, /experimental must be an object/],
  ];
  for (const [overrides, expected] of cases) {
    const response = await app.fetch(createRequest(createBody("public", overrides)), environment());
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, expected);
  }
});

test("every response carries the security headers, and the page forbids inline code", async () => {
  const page = await app.fetch(new Request("https://portal.example/"), environment());
  assert.equal(page.status, 200);
  const policy = page.headers.get("content-security-policy");
  assert.match(policy, /default-src 'none'/, "everything the page does must be named explicitly");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-inline/, "the portal no longer needs inline scripts or styles");
  assert.match(policy, /frame-ancestors 'none'/);
  // The document names its assets by content hash; a cached copy would outlive them.
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});

test("the client bundle and stylesheet are served from content-addressed, immutable URLs", async () => {
  const env = environment();
  const html = await (await app.fetch(new Request("https://portal.example/"), env)).text();
  const paths = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths.length, 2, "the document should reference exactly one script and one stylesheet");
  for (const path of paths) {
    assert.match(path, /^\/assets\/app\.[0-9a-f]{16}\.(js|css)$/);
    const response = await app.fetch(new Request(`https://portal.example${path}`), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await app.fetch(new Request("https://portal.example/assets/app.0000000000000000.js"), env)).status, 404);
});

test("an unknown route answers with the API's error shape", async () => {
  const response = await app.fetch(new Request("https://portal.example/nope"), environment());
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found", message: "route was not found" });
});
