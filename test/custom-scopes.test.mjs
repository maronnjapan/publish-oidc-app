import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";
import { MemoryD1, base64Url, signingEnvironment } from "./support/d1-mock.mjs";

/**
 * CLI's `--scope` option (docs/custom-scopes.md): a publisher declares application-specific
 * scopes beyond the standard six, and the generated OP is expected to advertise, accept and
 * grant exactly those, while still rejecting anything it was never told about.
 */

const opId = "maronn-op-customscope1";
const issuer = `https://${opId}.example.workers.dev`;
const config = {
  op_id: opId,
  name: "Custom Scope OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_scope123456789",
  client_secret: "custom-scope-secret-long-enough-for-testing",
  scopes: ["openid", "reports.read", "reports.write"],
  features: { pkce: true, "refresh-token": false, introspection: false, revocation: false, "request-object": false },
};

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-custom-scope-test-"));
const configPath = path.join(temporary, "config.json");
await writeFile(configPath, JSON.stringify(config));
const generated = await generateOp(opId, configPath);
const workerPath = path.join(temporary, "worker.mjs");
await writeFile(workerPath, await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory }));
const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);
const context = { waitUntil() {}, passThroughOnException() {} };

test("the generator declares the custom scopes to the CLI and records them in op.json", async () => {
  const scopesSource = await readFile(path.join(generated.appDirectory, "src/oidc-provider/scopes.ts"), "utf8");
  assert.match(scopesSource, /CUSTOM_SCOPES: readonly string\[\] = \['reports\.read', 'reports\.write'\]/);
  const metadata = JSON.parse(await readFile(path.join(generated.appDirectory, "op.json"), "utf8"));
  assert.deepEqual(metadata.scopes, ["openid", "reports.read", "reports.write"]);
});

test("discovery advertises exactly the publisher's selection, not the CLI's full declared set", async () => {
  const DB = new MemoryD1();
  const runtimeEnv = await signingEnvironment(issuer, opId, { ...config, scopes: ["openid", "reports.read"] }, DB);
  const response = await worker.default.fetch(new Request(`${issuer}/.well-known/openid-configuration`), runtimeEnv, context);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  // ALLOWED_SCOPES (the publisher's selection) narrows scopes_supported even though the
  // generated scopes.ts declared both reports.read and reports.write to the CLI.
  assert.deepEqual(metadata.scopes_supported, ["openid", "reports.read"]);
});

async function startSession(scopes = config.scopes) {
  const DB = new MemoryD1();
  await DB.addUser(opId, "alice", "password-123");
  const runtimeEnv = await signingEnvironment(issuer, opId, { ...config, scopes }, DB);
  const fetchWorker = (request) => worker.default.fetch(request, runtimeEnv, context);
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { DB, fetchWorker, verifier, challenge };
}

function authorizeUrl(scope, challenge) {
  const url = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: config.redirect_url,
    scope,
    state: "custom-scope-state",
    nonce: "custom-scope-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(name, value);
  }
  return url;
}

test("a scope the publisher never declared is rejected before login, even though openid is valid", async () => {
  const { fetchWorker, challenge } = await startSession();
  const response = await fetchWorker(new Request(authorizeUrl("openid reports.read reports.delete", challenge)));
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin + location.pathname, config.redirect_url);
  assert.equal(location.searchParams.get("error"), "invalid_scope");
});

test("a declared custom scope completes the authorization-code flow and is granted", async () => {
  const { DB, fetchWorker, verifier, challenge } = await startSession();
  const authorize = await fetchWorker(new Request(authorizeUrl("openid reports.read", challenge)));
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const loginUrl = new URL(authorize.headers.get("location"), issuer);
  const transactionId = loginUrl.searchParams.get("transaction_id");
  const loginPage = await fetchWorker(new Request(loginUrl));
  const csrfToken = (await loginPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(transactionId && csrfToken);

  const login = await fetchWorker(new Request(`${issuer}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" }),
  }));
  assert.equal(login.status, 302, await login.clone().text());

  const consentUrl = new URL(login.headers.get("location"), issuer);
  const consentPage = await fetchWorker(new Request(consentUrl));
  const consentHtml = await consentPage.text();
  // The consent screen lists exactly the requested-and-declared scopes: the standard one
  // and the custom one, nothing narrowed away by resolveGrantableScopes()'s empty default.
  assert.match(consentHtml, /reports\.read/);

  const consent = await fetchWorker(new Request(consentUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, action: "approve" }),
  }));
  assert.equal(consent.status, 302, await consent.clone().text());
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetchWorker(new Request(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: verifier }),
  }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json();
  assert.match(tokens.scope, /\breports\.read\b/);

  assert.ok(DB.kindsInUse().includes("authorization-code:"));
});
