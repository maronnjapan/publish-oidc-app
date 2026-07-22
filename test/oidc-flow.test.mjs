import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";

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
            } else if (sql.includes("json_extract(value_json, '$.grantId')")) {
              for (const [key, value] of database.records) {
                if (key.startsWith(`${params[0]}|${params[1]}|`) && JSON.parse(value.value_json).grantId === params[2]) database.records.delete(key);
              }
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

test("generated OP completes authorization-code login through shared D1", async () => {
  const opId = "maronn-op-flow123456";
  const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-flow-test-"));
  const configPath = path.join(temporary, "config.json");
  const config = {
    op_id: opId,
    name: "Flow OP",
    redirect_url: "https://client.example/callback",
    client_type: "confidential",
    client_id: "client_flow123456789",
    client_secret: "flow-secret-that-is-long-enough-for-testing",
    scopes: ["openid", "profile", "email"],
    features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
  };
  await writeFile(configPath, JSON.stringify(config));
  const generated = await generateOp(opId, configPath);
  const workerCode = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  const workerPath = path.join(temporary, "worker.mjs");
  await writeFile(workerPath, workerCode);
  const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);

  const keyPair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const issuer = "https://maronn-op-flow123456.example.workers.dev";
  const DB = new FlowDatabase();
  DB.users.set(`${opId}|alice`, await passwordRow("alice", "password-123"));
  const runtimeEnv = {
    DB,
    OP_ID: opId,
    OP_ISSUER: issuer,
    ALLOWED_SCOPES: JSON.stringify(config.scopes),
    OIDC_SIGNING_JWK: JSON.stringify({ ...privateJwk, alg: "RS256", use: "sig", kid: "flow-key" }),
    OIDC_CLIENT_CONFIG: JSON.stringify({ clientId: config.client_id, clientSecret: config.client_secret, redirectUris: [config.redirect_url], clientType: "confidential", offlineAccessAllowed: true, grantTypes: ["authorization_code", "refresh_token"], tokenEndpointAuthMethod: "client_secret_post" }),
  };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const fetchWorker = (request) => worker.default.fetch(request, runtimeEnv, context);

  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid profile email", state: "flow-state", nonce: "flow-nonce", code_challenge: challenge, code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const authorize = await fetchWorker(new Request(authorizeUrl));
  assert.equal(authorize.status, 302);
  const loginUrl = new URL(authorize.headers.get("location"), issuer);
  const transactionId = loginUrl.searchParams.get("transaction_id");
  assert.ok(transactionId);

  const loginPage = await fetchWorker(new Request(loginUrl));
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  const csrfToken = loginHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken);

  const loginBody = new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" });
  const login = await fetchWorker(new Request(`${issuer}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: loginBody }));
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie"), /session_id=/);
  const consentUrl = new URL(login.headers.get("location"), issuer);

  const consentBody = new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, action: "approve" });
  const consent = await fetchWorker(new Request(consentUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: consentBody }));
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, config.redirect_url);
  assert.equal(callback.searchParams.get("state"), "flow-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenBody = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: verifier });
  const tokenResponse = await fetchWorker(new Request(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.id_token);

  const userinfoResponse = await fetchWorker(new Request(`${issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
  assert.equal(userinfoResponse.status, 200, await userinfoResponse.clone().text());
  const claims = await userinfoResponse.json();
  assert.equal(claims.sub, "alice");
  assert.equal(claims.email, "alice@example.com");
  assert.ok([...DB.records.keys()].every((key) => key.startsWith(`${opId}|`)));
});
