import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle, readExperimentalCatalog, supportedExperimentalFeatures } from "../scripts/lib.mjs";

function base64Url(value) { return Buffer.from(value).toString("base64url"); }

class FlowDatabase {
  records = new Map();
  consents = new Map();
  grants = new Set();
  users = new Map();

  prepare(sql) {
    const database = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes("FROM oidc_records")) return database.records.get(`${params[0]}|${params[1]}|${params[2]}`) ?? null;
            if (sql.includes("password_hash") && sql.includes("FROM oidc_users")) return database.users.get(`${params[0]}|${params[1]}`) ?? null;
            if (sql.includes("SELECT claims_json FROM oidc_users")) {
              const user = database.users.get(`${params[0]}|${params[1]}`);
              return user ? { claims_json: user.claims_json } : null;
            }
            if (sql.includes("SELECT scopes_json FROM oidc_consents")) {
              const scopes_json = database.consents.get(`${params[0]}|${params[1]}|${params[2]}`);
              return scopes_json ? { scopes_json } : null;
            }
            return null;
          },
          async run() {
            if (sql.startsWith("INSERT INTO oidc_records")) {
              database.records.set(`${params[0]}|${params[1]}|${params[2]}`, { value_json: params[3], expires_at: params[4], updated_at: params[5] });
            } else if (sql.startsWith("DELETE FROM oidc_records") && sql.includes("record_key")) {
              database.records.delete(`${params[0]}|${params[1]}|${params[2]}`);
            } else if (sql.startsWith("INSERT INTO oidc_consents")) {
              database.consents.set(`${params[0]}|${params[1]}|${params[2]}`, params[3]);
            } else if (sql.startsWith("INSERT OR IGNORE INTO oidc_consent_grants")) {
              database.grants.add(params.join("|"));
            }
            return { success: true };
          },
          async all() { return { success: true, results: [] }; },
        };
      },
    };
  }

  async batch(statements) { for (const statement of statements) await statement.run(); return []; }
}

async function passwordRow(username, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = new TextEncoder().encode(password);
  const saltedPassword = new Uint8Array(salt.length + passwordBytes.length);
  saltedPassword.set(salt);
  saltedPassword.set(passwordBytes, salt.length);
  const hash = await webcrypto.subtle.digest("SHA-256", saltedPassword);
  return { username, password_hash: base64Url(new Uint8Array(hash)), password_salt: base64Url(salt), password_iterations: 1, claims_json: JSON.stringify({ sub: username, name: "Alice Example", preferred_username: username, email: "alice@example.com", email_verified: true }) };
}

const opId = "maronn-op-par1234567";
const config = {
  op_id: opId,
  name: "PAR OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_par123456789",
  client_secret: "par-secret-that-is-long-enough-for-testing",
  scopes: ["openid", "profile", "email"],
  features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
  experimental: { par: { required: true } },
};

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-par-test-"));
const configPath = path.join(temporary, "config.json");
await writeFile(configPath, JSON.stringify(config));
const generated = await generateOp(opId, configPath);
const workerCode = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
const workerPath = path.join(temporary, "worker.mjs");
await writeFile(workerPath, workerCode);
const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);

const issuer = "https://maronn-op-par1234567.example.workers.dev";
const keyPair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);

function createEnvironment() {
  const DB = new FlowDatabase();
  return {
    DB,
    OP_ID: opId,
    OP_ISSUER: issuer,
    ALLOWED_SCOPES: JSON.stringify(config.scopes),
    EXPERIMENTAL_FEATURES: JSON.stringify(generated.experimental),
    OIDC_SIGNING_JWK: JSON.stringify({ ...privateJwk, alg: "RS256", use: "sig", kid: "par-key" }),
    OIDC_CLIENT_CONFIG: JSON.stringify({ clientId: config.client_id, clientSecret: config.client_secret, redirectUris: [config.redirect_url], clientType: "confidential", offlineAccessAllowed: false, grantTypes: ["authorization_code", "refresh_token"], tokenEndpointAuthMethod: "client_secret_post" }),
  };
}

const context = { waitUntil() {}, passThroughOnException() {} };
const fetchWith = (environment) => (request) => worker.default.fetch(request, environment, context);

async function pushAuthorizationRequest(fetchWorker, overrides = {}) {
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const body = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    client_secret: config.client_secret,
    redirect_uri: config.redirect_url,
    scope: "openid profile email",
    state: "par-state",
    nonce: "par-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  });
  const response = await fetchWorker(new Request(`${issuer}/par`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
  return { response, verifier };
}

test("the experimental catalog only advertises features the generator can wire", async () => {
  const catalog = await readExperimentalCatalog();
  const supported = supportedExperimentalFeatures(catalog);
  assert.ok(supported.some((feature) => feature.id === "par"));
  for (const feature of supported) assert.match(feature.subpath, /^@maronn-oidc\/experimental\//);
});

test("discovery advertises the pushed authorization request endpoint", async () => {
  const response = await fetchWith(createEnvironment())(new Request(`${issuer}/.well-known/openid-configuration`));
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.pushed_authorization_request_endpoint, `${issuer}/par`);
  assert.equal(metadata.require_pushed_authorization_requests, true);
  assert.deepEqual(metadata.scopes_supported, config.scopes);
});

test("a pushed request_uri drives the authorization code flow to a token", async () => {
  const environment = createEnvironment();
  environment.DB.users.set(`${opId}|alice`, await passwordRow("alice", "password-123"));
  const fetchWorker = fetchWith(environment);

  const { response: pushed, verifier } = await pushAuthorizationRequest(fetchWorker);
  assert.equal(pushed.status, 201, await pushed.clone().text());
  assert.equal(pushed.headers.get("cache-control"), "no-store");
  const pushedBody = await pushed.json();
  assert.match(pushedBody.request_uri, /^urn:ietf:params:oauth:request_uri:/);
  assert.equal(pushedBody.expires_in, 90);

  const authorizeUrl = new URL(`${issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", config.client_id);
  authorizeUrl.searchParams.set("request_uri", pushedBody.request_uri);
  const authorize = await fetchWorker(new Request(authorizeUrl));
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const loginUrl = new URL(authorize.headers.get("location"), issuer);
  const transactionId = loginUrl.searchParams.get("transaction_id");
  assert.ok(transactionId);

  const loginHtml = await (await fetchWorker(new Request(loginUrl))).text();
  const csrfToken = loginHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken);
  const login = await fetchWorker(new Request(`${issuer}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" }) }));
  assert.equal(login.status, 302);
  const consent = await fetchWorker(new Request(new URL(login.headers.get("location"), issuer), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, action: "approve" }) }));
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "par-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetchWorker(new Request(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: verifier }) }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.id_token);
});

test("a request_uri is single use", async () => {
  const fetchWorker = fetchWith(createEnvironment());
  const { response: pushed } = await pushAuthorizationRequest(fetchWorker);
  const { request_uri: requestUri } = await pushed.json();
  const authorizeUrl = new URL(`${issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", config.client_id);
  authorizeUrl.searchParams.set("request_uri", requestUri);

  assert.equal((await fetchWorker(new Request(authorizeUrl))).status, 302);
  const replay = await fetchWorker(new Request(authorizeUrl));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_request_uri");
});

test("required mode rejects an authorization request without a pushed request_uri", async () => {
  const fetchWorker = fetchWith(createEnvironment());
  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_request");
  assert.match(body.error_description, /Pushed authorization requests are required/);
});

test("the pushed endpoint authenticates the client and enforces the selected scopes", async () => {
  const fetchWorker = fetchWith(createEnvironment());

  const wrongSecret = await pushAuthorizationRequest(fetchWorker, { client_secret: "not-the-registered-secret-value" });
  assert.equal(wrongSecret.response.status, 401);
  assert.equal((await wrongSecret.response.json()).error, "invalid_client");

  const unsupportedScope = await pushAuthorizationRequest(fetchWorker, { scope: "openid address" });
  assert.equal(unsupportedScope.response.status, 400);
  const scopeBody = await unsupportedScope.response.json();
  assert.equal(scopeBody.error, "invalid_scope");
  assert.match(scopeBody.error_description, /address/);

  const nestedRequestUri = await pushAuthorizationRequest(fetchWorker, { request_uri: "urn:ietf:params:oauth:request_uri:forged" });
  assert.equal(nestedRequestUri.response.status, 400);
  assert.equal((await nestedRequestUri.response.json()).error, "invalid_request");

  const wrongMethod = await fetchWorker(new Request(`${issuer}/par`, { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
});

test("optional mode still accepts a plain authorization request", async () => {
  const environment = { ...createEnvironment(), EXPERIMENTAL_FEATURES: JSON.stringify({ par: { required: false } }) };
  const fetchWorker = fetchWith(environment);

  const discovery = await (await fetchWorker(new Request(`${issuer}/.well-known/openid-configuration`))).json();
  assert.equal(discovery.require_pushed_authorization_requests, false);

  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid", state: "plain", code_challenge: "x".repeat(43), code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /\/login\?transaction_id=/);
});

test("the pushed endpoint answers CORS preflight for browser clients", async () => {
  const response = await fetchWith(createEnvironment())(new Request(`${issuer}/par`, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST" } }));
  assert.ok(response.status === 204 || response.status === 200, `unexpected preflight status ${response.status}`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("a request_uri cannot be replayed by a different client id", async () => {
  const fetchWorker = fetchWith(createEnvironment());
  const { response: pushed } = await pushAuthorizationRequest(fetchWorker);
  const { request_uri: requestUri } = await pushed.json();
  const authorizeUrl = new URL(`${issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", "client_someoneelse12");
  authorizeUrl.searchParams.set("request_uri", requestUri);
  const response = await fetchWorker(new Request(authorizeUrl));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_request_uri");
});
