import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";
import { MemoryD1, base64Url, signingEnvironment } from "./support/d1-mock.mjs";

const opId = "maronn-op-flow123456";
const issuer = `https://${opId}.example.workers.dev`;
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

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-flow-test-"));
const configPath = path.join(temporary, "config.json");
await writeFile(configPath, JSON.stringify(config));
const generated = await generateOp(opId, configPath);
const workerPath = path.join(temporary, "worker.mjs");
await writeFile(workerPath, await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory }));
const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);

const context = { waitUntil() {}, passThroughOnException() {} };

async function startSession() {
  const DB = new MemoryD1();
  await DB.addUser(opId, "alice", "password-123");
  const runtimeEnv = await signingEnvironment(issuer, opId, config, DB);
  const fetchWorker = (request) => worker.default.fetch(request, runtimeEnv, context);
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid profile email", state: "flow-state", nonce: "flow-nonce", code_challenge: challenge, code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const authorize = await fetchWorker(new Request(authorizeUrl));
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const transactionId = new URL(authorize.headers.get("location"), issuer).searchParams.get("transaction_id");
  const loginPage = await fetchWorker(new Request(new URL(authorize.headers.get("location"), issuer)));
  const csrfToken = (await loginPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(transactionId && csrfToken);
  const login = (username, password) => fetchWorker(new Request(`${issuer}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, username, password }) }));
  return { DB, fetchWorker, transactionId, csrfToken, verifier, login };
}

test("generated OP completes authorization-code login through shared D1", async () => {
  const { DB, fetchWorker, transactionId, csrfToken, verifier, login } = await startSession();

  const loggedIn = await login("alice", "password-123");
  assert.equal(loggedIn.status, 302, await loggedIn.clone().text());
  assert.match(loggedIn.headers.get("set-cookie"), /session_id=/);

  const consentBody = new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, action: "approve" });
  const consent = await fetchWorker(new Request(new URL(loggedIn.headers.get("location"), issuer), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: consentBody }));
  assert.equal(consent.status, 302, await consent.clone().text());
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

  // Every row the flow wrote is namespaced by op_id, and each store's key prefix lands in
  // the indexed `kind` column instead of being folded into the hashed record key.
  assert.ok([...DB.records.keys()].every((key) => key.startsWith(`${opId}|`)));
  // The auth transaction is consumed when the code is issued, so it is gone by now.
  for (const kind of ["access-token:", "authorization-code:", "consent:", "browser-session:"]) {
    assert.ok(DB.kindsInUse().includes(kind), `expected a ${kind} record, saw ${DB.kindsInUse().join(", ")}`);
  }
});

test("the CLI's development fixture account cannot log in to a published OP", async () => {
  const { login } = await startSession();
  // The generated store.ts seeds `testuser` into both its JSON-backed and in-memory user
  // stores. Only accounts registered through the portal may authenticate.
  const response = await login("testuser", "password");
  assert.equal(response.status, 200, "a rejected login re-renders the form rather than redirecting");
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_id=/);
});
