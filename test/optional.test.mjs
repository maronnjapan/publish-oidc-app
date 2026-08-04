import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unknownHelpHeadings } from "../scripts/check-package-updates.mjs";
import { OPTIONAL_WIRING, generateOp, parseOptionalSelection } from "../scripts/generate-op.mjs";
import { bundle, readOptionalCatalog, supportedFeatures } from "../scripts/lib.mjs";
import { MemoryD1, base64Url, signingEnvironment } from "./support/d1-mock.mjs";

const execFile = promisify(execFileCallback);

const config = {
  name: "Optional OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_opt123456789",
  client_secret: "optional-secret-long-enough-for-testing",
  scopes: ["openid", "profile", "email"],
  features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
};

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-optional-test-"));

/** The optional selection is baked into the generated code, so each mode is its own OP. */
async function buildWorker(opId, optional) {
  const configPath = path.join(temporary, `${opId}.json`);
  await writeFile(configPath, JSON.stringify({ ...config, op_id: opId, optional }));
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
      const runtimeEnv = await signingEnvironment(issuer, opId, { ...config, op_id: opId }, DB);
      return { DB, fetch: (request) => worker.default.fetch(request, runtimeEnv, context) };
    },
  };
}

const bound = await buildWorker("maronn-op-bound1234567", { "transaction-binding": {} });
const unbound = await buildWorker("maronn-op-unbound12345", {});

/** Starts an authorization request and returns what a browser would hold afterwards. */
async function startFlow(fetchWorker, issuer, state) {
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(`${issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid profile", state, nonce: "n", code_challenge: challenge, code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  const location = response.headers.get("location");
  return {
    verifier,
    response,
    loginUrl: new URL(location, issuer),
    transactionId: new URL(location, issuer).searchParams.get("transaction_id"),
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

function csrfFrom(html) {
  return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "";
}

test("the catalog only advertises optional features the CLI and the generator both know", async () => {
  const catalog = await readOptionalCatalog();
  const supported = supportedFeatures(catalog);
  assert.deepEqual(supported.map((feature) => feature.id).sort(), ["transaction-binding"]);
  const cliFeatures = await readFile("node_modules/@maronn-openid-connect/cli/dist/features.js", "utf8");
  for (const feature of supported) {
    // The portal offers whatever is `supported`. Without matching wiring — and without
    // the CLI knowing the id — the request would pass validation, burn the caller's
    // daily quota, and only then fail in CI.
    assert.ok(Object.prototype.hasOwnProperty.call(OPTIONAL_WIRING, feature.id), `${feature.id} has no OPTIONAL_WIRING entry (docs/optional-features.md)`);
    assert.match(cliFeatures, new RegExp(`'${feature.id}'`), `${feature.id} is not in the pinned CLI's OPTIONAL_FEATURES`);
  }
  // Optional features are CLI-native; a catalog entry claiming a package subpath would
  // mean it belongs in experimental-features.json instead.
  for (const feature of catalog.features) assert.equal("subpath" in feature, false, `${feature.id} must not declare a package subpath`);
});

test("every toggle group the pinned CLI prints is one this repository reads", async () => {
  const { stdout } = await execFile(process.execPath, ["node_modules/@maronn-openid-connect/cli/dist/index.js", "--help"]);

  // The failure this guards against: the CLI grows a fourth group, the follow-up report
  // stays quiet because nothing parses it, and the portal never learns it could offer it.
  // Add a HELP_SECTIONS pattern plus a catalog when this fails — see docs/optional-features.md.
  assert.deepEqual(unknownHelpHeadings(stdout), []);

  const printed = stdout.match(/^Optional features \(disabled by default\):[^\S\n]*(.+)$/m)?.[1] ?? "";
  const catalog = await readOptionalCatalog();
  assert.deepEqual(
    printed.split(",").map((id) => id.trim()).filter(Boolean).sort(),
    catalog.features.map((feature) => feature.id).sort(),
    "optional-features.json must list exactly what the pinned CLI can generate",
  );
});

test("optional selections are validated against the catalog", async () => {
  const catalog = await readOptionalCatalog();
  assert.deepEqual(parseOptionalSelection({ "transaction-binding": {} }, catalog), { "transaction-binding": {} });
  assert.deepEqual(parseOptionalSelection(undefined, catalog), {});
  assert.throws(() => parseOptionalSelection({ par: {} }, catalog), /optional feature "par" is not supported/);
  assert.throws(() => parseOptionalSelection({ "transaction-binding": { nope: true } }, catalog), /optional option "transaction-binding.nope" is not supported/);
  assert.throws(() => parseOptionalSelection([], catalog), /optional selection must be an object/);
});

test("an OP without optional features keeps the plain authorization flow", async () => {
  const { fetch: fetchWorker } = await unbound.client();
  const flow = await startFlow(fetchWorker, unbound.issuer, "plain");

  assert.equal(flow.response.status, 302);
  assert.equal(flow.response.headers.get("set-cookie"), null, "no binding cookie is issued when the feature is off");
  assert.deepEqual(JSON.parse(await readFile(path.join(unbound.generated.appDirectory, "op.json"), "utf8")).optional, {});

  // Without the feature the login form is reachable with the transaction id alone.
  const loginPage = await fetchWorker(new Request(flow.loginUrl));
  assert.equal(loginPage.status, 200);
  assert.ok(csrfFrom(await loginPage.text()));
});

test("transaction binding issues a per-transaction cookie and rejects other browsers", async () => {
  const { fetch: fetchWorker } = await bound.client();
  const flow = await startFlow(fetchWorker, bound.issuer, "bound");

  assert.equal(flow.response.status, 302);
  assert.ok(flow.cookie.startsWith(`oidc_txn_${flow.transactionId}=`), `unexpected binding cookie: ${flow.cookie}`);
  assert.match(flow.response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  // Only the hash is kept server side, so a leaked transaction record is not a usable cookie.
  const secret = flow.cookie.slice(flow.cookie.indexOf("=") + 1);
  assert.ok(secret.length > 0);

  // The CSRF token lives in this HTML: a caller holding only the transaction id must not read it.
  const withoutCookie = await fetchWorker(new Request(flow.loginUrl));
  assert.equal(withoutCookie.status, 400);
  assert.equal(csrfFrom(await withoutCookie.text()), "");

  const withCookie = await fetchWorker(new Request(flow.loginUrl, { headers: { Cookie: flow.cookie } }));
  assert.equal(withCookie.status, 200);
  assert.ok(csrfFrom(await withCookie.text()));
});

test("transaction binding still completes the authorization code flow for the owning browser", async () => {
  const { fetch: fetchWorker } = await bound.client();
  const flow = await startFlow(fetchWorker, bound.issuer, "bound-happy");
  const headers = { "content-type": "application/x-www-form-urlencoded", Cookie: flow.cookie };
  const csrfToken = csrfFrom(await (await fetchWorker(new Request(flow.loginUrl, { headers: { Cookie: flow.cookie } }))).text());

  const login = await fetchWorker(new Request(`${bound.issuer}/login`, { method: "POST", headers, body: new URLSearchParams({ transaction_id: flow.transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" }) }));
  assert.equal(login.status, 302, await login.clone().text());

  const consentUrl = new URL(login.headers.get("location"), bound.issuer);
  const consentCsrf = csrfFrom(await (await fetchWorker(new Request(consentUrl, { headers: { Cookie: flow.cookie } }))).text());
  const consent = await fetchWorker(new Request(`${bound.issuer}/consent`, { method: "POST", headers, body: new URLSearchParams({ transaction_id: flow.transactionId, csrf_token: consentCsrf, action: "approve" }) }));
  const callback = new URL(consent.headers.get("location"));
  const code = callback.searchParams.get("code");
  assert.ok(code, `no authorization code in ${callback}`);
  assert.equal(callback.searchParams.get("state"), "bound-happy");

  const tokenResponse = await fetchWorker(new Request(`${bound.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: flow.verifier }) }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  assert.ok((await tokenResponse.json()).access_token);
});

test("another transactions binding cookie cannot approve consent", async () => {
  const { fetch: fetchWorker } = await bound.client();
  const victim = await startFlow(fetchWorker, bound.issuer, "victim");
  const victimHeaders = { "content-type": "application/x-www-form-urlencoded", Cookie: victim.cookie };
  const csrfToken = csrfFrom(await (await fetchWorker(new Request(victim.loginUrl, { headers: { Cookie: victim.cookie } }))).text());
  const login = await fetchWorker(new Request(`${bound.issuer}/login`, { method: "POST", headers: victimHeaders, body: new URLSearchParams({ transaction_id: victim.transactionId, csrf_token: csrfToken, username: "alice", password: "password-123" }) }));
  const consentUrl = new URL(login.headers.get("location"), bound.issuer);
  const consentCsrf = csrfFrom(await (await fetchWorker(new Request(consentUrl, { headers: { Cookie: victim.cookie } }))).text());

  // The attacker holds a perfectly valid binding cookie - for their own transaction.
  const attacker = await startFlow(fetchWorker, bound.issuer, "attacker");
  const response = await fetchWorker(new Request(`${bound.issuer}/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: attacker.cookie },
    body: new URLSearchParams({ transaction_id: victim.transactionId, csrf_token: consentCsrf, action: "approve" }),
  }));

  // Stopped by the OP, never redirected onward with a code for the victim's identity.
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});
