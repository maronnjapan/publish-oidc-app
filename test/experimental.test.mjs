import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EXPERIMENTAL_WIRING, generateOp, parseExperimentalSelection } from "../scripts/generate-op.mjs";
import { bundle, readExperimentalCatalog, supportedFeatures } from "../scripts/lib.mjs";
import { MemoryD1, base64Url, signingEnvironment } from "./support/d1-mock.mjs";

const config = {
  name: "Experimental OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_exp123456789",
  client_secret: "experimental-secret-long-enough-for-testing",
  scopes: ["openid", "profile", "email"],
  features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
};

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-experimental-test-"));

/** The experimental selection is baked into the generated code, so each mode is its own OP. */
async function buildWorker(opId, experimental) {
  const configPath = path.join(temporary, `${opId}.json`);
  await writeFile(configPath, JSON.stringify({ ...config, op_id: opId, experimental }));
  const generated = await generateOp(opId, configPath);
  const workerPath = path.join(temporary, `${opId}.mjs`);
  await writeFile(workerPath, await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory }));
  const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);
  const issuer = `https://${opId}.example.workers.dev`;
  const context = { waitUntil() {}, passThroughOnException() {} };
  return {
    generated,
    issuer,
    async client() {
      const DB = new MemoryD1();
      await DB.addUser(opId, "alice", "password-123");
      const runtimeEnv = await signingEnvironment(issuer, opId, { ...config, op_id: opId }, DB, experimental);
      return { DB, fetch: (request) => worker.default.fetch(request, runtimeEnv, context) };
    },
  };
}

const required = await buildWorker("maronn-op-parreq12345", { par: { required: true } });
const optional = await buildWorker("maronn-op-paropt12345", { par: {} });
const exchange = await buildWorker("maronn-op-exch12345678", { "token-exchange": {} });

async function pushAuthorizationRequest(fetchWorker, issuer, overrides = {}) {
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

/** Drives login + consent for an authorization request that already reached /login. */
async function completeLogin(fetchWorker, issuer, location) {
  const loginUrl = new URL(location, issuer);
  const transactionId = loginUrl.searchParams.get("transaction_id");
  const csrfToken = (await (await fetchWorker(new Request(loginUrl))).text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const login = await fetchWorker(new Request(`${issuer}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" }) }));
  const consent = await fetchWorker(new Request(new URL(login.headers.get("location"), issuer), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, action: "approve" }) }));
  return new URL(consent.headers.get("location"));
}

test("the catalog only advertises features the CLI and the generator both know", async () => {
  const catalog = await readExperimentalCatalog();
  const supported = supportedFeatures(catalog);
  assert.deepEqual(supported.map((feature) => feature.id).sort(), ["par", "token-exchange"]);
  const cliHelp = await readFile("node_modules/@maronn-openid-connect/cli/dist/features.js", "utf8");
  for (const feature of supported) {
    assert.match(feature.subpath, /^@maronn-openid-connect\/experimental\//);
    // The portal offers whatever is `supported`. Without matching wiring — and without
    // the CLI knowing the id — the request would pass validation, burn the caller's
    // daily quota, and only then fail in CI.
    assert.ok(Object.prototype.hasOwnProperty.call(EXPERIMENTAL_WIRING, feature.id), `${feature.id} has no EXPERIMENTAL_WIRING entry (docs/experimental.md)`);
    assert.match(cliHelp, new RegExp(`'${feature.id}'`), `${feature.id} is not in the pinned CLI's EXPERIMENTAL_FEATURES`);
  }
});

test("experimental option defaults are applied consistently by the generator", async () => {
  const catalog = await readExperimentalCatalog();
  assert.deepEqual(parseExperimentalSelection({ par: {} }, catalog), { par: { required: false } });
  assert.deepEqual(parseExperimentalSelection({ par: null }, catalog), { par: { required: false } });
  assert.deepEqual(parseExperimentalSelection({ "token-exchange": {} }, catalog), { "token-exchange": {} });
  assert.deepEqual(parseExperimentalSelection(undefined, catalog), {});
  assert.throws(() => parseExperimentalSelection({ dpop: {} }, catalog), /is not supported/);
  assert.throws(() => parseExperimentalSelection({ par: { nope: true } }, catalog), /is not supported/);
});

test("an OP without experimental features generates neither the routes nor the metadata", async () => {
  const plain = await buildWorker("maronn-op-plain1234567", {});
  const { fetch: fetchWorker } = await plain.client();
  const metadata = await (await fetchWorker(new Request(`${plain.issuer}/.well-known/openid-configuration`))).json();
  assert.equal("pushed_authorization_request_endpoint" in metadata, false);
  assert.ok(!metadata.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:token-exchange"));
  assert.equal((await fetchWorker(new Request(`${plain.issuer}/par`, { method: "POST" }))).status, 404);
  assert.deepEqual(JSON.parse(await readFile(path.join(plain.generated.appDirectory, "op.json"), "utf8")).experimental, {});
});

test("discovery advertises the pushed authorization request endpoint", async () => {
  const { fetch: fetchWorker } = await required.client();
  const metadata = await (await fetchWorker(new Request(`${required.issuer}/.well-known/openid-configuration`))).json();
  assert.equal(metadata.pushed_authorization_request_endpoint, `${required.issuer}/par`);
  assert.equal(metadata.require_pushed_authorization_requests, true);
  assert.deepEqual(metadata.scopes_supported, config.scopes);

  const optionalMetadata = await (await (await optional.client()).fetch(new Request(`${optional.issuer}/.well-known/openid-configuration`))).json();
  assert.notEqual(optionalMetadata.require_pushed_authorization_requests, true);
});

test("a pushed request_uri drives the authorization code flow to a token", async () => {
  const { DB, fetch: fetchWorker } = await required.client();
  const { response: pushed, verifier } = await pushAuthorizationRequest(fetchWorker, required.issuer);
  assert.equal(pushed.status, 201, await pushed.clone().text());
  assert.match(pushed.headers.get("cache-control"), /no-store/);
  const pushedBody = await pushed.json();
  assert.match(pushedBody.request_uri, /^urn:ietf:params:oauth:request_uri:/);
  assert.ok(pushedBody.expires_in > 0);
  // The pushed request is persisted to the shared D1, not to worker memory.
  assert.ok(DB.kindsInUse().includes("par-request:"));
  // Client credentials must never be stored alongside the pushed parameters.
  assert.ok([...DB.records.values()].every((row) => !row.value_json.includes(config.client_secret)));

  const authorizeUrl = new URL(`${required.issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", config.client_id);
  authorizeUrl.searchParams.set("request_uri", pushedBody.request_uri);
  const authorize = await fetchWorker(new Request(authorizeUrl));
  assert.equal(authorize.status, 302, await authorize.clone().text());

  const callback = await completeLogin(fetchWorker, required.issuer, authorize.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "par-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetchWorker(new Request(`${required.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: verifier }) }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  assert.ok((await tokenResponse.json()).access_token);
});

test("a request_uri is single use, including under concurrency", async () => {
  const { fetch: fetchWorker } = await required.client();
  const { response: pushed } = await pushAuthorizationRequest(fetchWorker, required.issuer);
  const authorizeUrl = new URL(`${required.issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", config.client_id);
  authorizeUrl.searchParams.set("request_uri", (await pushed.json()).request_uri);
  assert.equal((await fetchWorker(new Request(authorizeUrl))).status, 302);
  assert.equal((await fetchWorker(new Request(authorizeUrl))).status, 400);

  const { fetch: raceFetch } = await required.client();
  const { response: racePushed } = await pushAuthorizationRequest(raceFetch, required.issuer);
  const raceUrl = new URL(`${required.issuer}/authorize`);
  raceUrl.searchParams.set("client_id", config.client_id);
  raceUrl.searchParams.set("request_uri", (await racePushed.json()).request_uri);
  const raced = await Promise.all([raceFetch(new Request(raceUrl)), raceFetch(new Request(raceUrl))]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [302, 400], "only one racing request may spend the pushed reference");
});

test("required mode rejects an authorization request without a pushed request_uri", async () => {
  const { fetch: fetchWorker } = await required.client();
  const authorizeUrl = new URL(`${required.issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  assert.equal((await fetchWorker(new Request(authorizeUrl))).status, 400);
});

test("optional mode still accepts a plain authorization request", async () => {
  const { fetch: fetchWorker } = await optional.client();
  const authorizeUrl = new URL(`${optional.issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid", state: "plain", code_challenge: "x".repeat(43), code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /\/login\?transaction_id=/);
});

test("the pushed endpoint authenticates the client and enforces the selected scopes", async () => {
  const { fetch: fetchWorker } = await required.client();

  const wrongSecret = await pushAuthorizationRequest(fetchWorker, required.issuer, { client_secret: "not-the-registered-secret-value" });
  assert.equal(wrongSecret.response.status, 401);
  assert.equal((await wrongSecret.response.json()).error, "invalid_client");

  const unsupportedScope = await pushAuthorizationRequest(fetchWorker, required.issuer, { scope: "openid address" });
  assert.equal(unsupportedScope.response.status, 400);
  assert.equal((await unsupportedScope.response.json()).error, "invalid_scope");

  const nested = await pushAuthorizationRequest(fetchWorker, required.issuer, { request_uri: "urn:ietf:params:oauth:request_uri:forged" });
  assert.equal(nested.response.status, 400);
});

test("a request_uri cannot be redeemed by a different client id", async () => {
  const { fetch: fetchWorker } = await required.client();
  const { response: pushed } = await pushAuthorizationRequest(fetchWorker, required.issuer);
  const authorizeUrl = new URL(`${required.issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", "client_someoneelse12");
  authorizeUrl.searchParams.set("request_uri", (await pushed.json()).request_uri);
  assert.equal((await fetchWorker(new Request(authorizeUrl))).status, 400);
});

/** Runs a full authorization-code flow and returns the issued token response. */
async function issueAccessToken(fetchWorker, issuer) {
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid profile email", state: "x", nonce: "n", code_challenge: challenge, code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const authorize = await fetchWorker(new Request(authorizeUrl));
  const callback = await completeLogin(fetchWorker, issuer, authorize.headers.get("location"));
  const response = await fetchWorker(new Request(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code"), redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: verifier }) }));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("token exchange narrows an issued access token", async () => {
  const { fetch: fetchWorker } = await exchange.client();
  const metadata = await (await fetchWorker(new Request(`${exchange.issuer}/.well-known/openid-configuration`))).json();
  assert.ok(metadata.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:token-exchange"));

  const tokens = await issueAccessToken(fetchWorker, exchange.issuer);
  assert.ok(tokens.access_token);

  const exchanged = await fetchWorker(new Request(`${exchange.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: tokens.access_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "openid profile",
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  }));
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const result = await exchanged.json();
  assert.ok(result.access_token);
  assert.equal(result.issued_token_type, "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(result.scope, "openid profile", "the exchanged token must carry only the narrowed scopes");
  assert.notEqual(result.access_token, tokens.access_token);
});

test("token exchange rejects a target that is not on the allow list", async () => {
  const { fetch: fetchWorker } = await exchange.client();
  const tokens = await issueAccessToken(fetchWorker, exchange.issuer);
  const response = await fetchWorker(new Request(`${exchange.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: tokens.access_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "https://downstream.example",
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  }));
  assert.equal(response.status, 400, await response.clone().text());
  // allowedTargets is empty by default, so naming any downstream service is rejected
  // rather than silently honoured (fail safe, see docs/experimental.md).
  assert.equal((await response.json()).error, "invalid_target");
});

test("token exchange rejects an unknown subject token", async () => {
  const { fetch: fetchWorker } = await exchange.client();
  const response = await fetchWorker(new Request(`${exchange.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "not-a-real-token",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  }));
  assert.equal(response.status, 400);
});
