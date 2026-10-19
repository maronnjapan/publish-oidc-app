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
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

function csrfFrom(html) {
  return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "";
}

test("the catalog only advertises optional features the CLI and the generator both know", async () => {
  const catalog = await readOptionalCatalog();
  const supported = supportedFeatures(catalog);
  assert.deepEqual(supported.map((feature) => feature.id).sort(), []);
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
  // The real catalog is empty right now, so the validation machinery is exercised with a
  // synthetic one: the next optional feature must behave the same way.
  const catalog = { features: [{ id: "example-hardening", status: "supported", options: [{ id: "strict", default: false }] }, { id: "pending", status: "detected" }] };
  assert.deepEqual(parseOptionalSelection({ "example-hardening": {} }, catalog), { "example-hardening": { strict: false } });
  assert.deepEqual(parseOptionalSelection(undefined, catalog), {});
  assert.throws(() => parseOptionalSelection({ par: {} }, catalog), /optional feature "par" is not supported/);
  assert.throws(() => parseOptionalSelection({ pending: {} }, catalog), /optional feature "pending" is not supported/);
  assert.throws(() => parseOptionalSelection({ "example-hardening": { nope: true } }, catalog), /optional option "example-hardening.nope" is not supported/);
  assert.throws(() => parseOptionalSelection([], catalog), /optional selection must be an object/);
});

test("the transaction binding that used to be optional is now the default flow", async () => {
  const { fetch: fetchWorker } = await unbound.client();
  const flow = await startFlow(fetchWorker, unbound.issuer, "plain");

  assert.equal(flow.response.status, 302);
  // cli 0.11.0 made the cookie binding standard: the transaction id never appears in the URL.
  assert.equal(flow.loginUrl.searchParams.get("transaction_id"), null);
  assert.match(flow.response.headers.get("set-cookie") ?? "", /^__Host-oidc_txn=[^;]+; HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(JSON.parse(await readFile(path.join(unbound.generated.appDirectory, "op.json"), "utf8")).optional, {});

  // The CSRF token lives in the login HTML: a browser without the cookie must not read it.
  const withoutCookie = await fetchWorker(new Request(flow.loginUrl));
  assert.equal(withoutCookie.status, 400);
  assert.equal(csrfFrom(await withoutCookie.text()), "");
  const withCookie = await fetchWorker(new Request(flow.loginUrl, { headers: { Cookie: flow.cookie } }));
  assert.equal(withCookie.status, 200);
  assert.ok(csrfFrom(await withCookie.text()));
});

test("the retired transaction-binding id is refused rather than silently ignored", async () => {
  const catalog = await readOptionalCatalog();
  assert.throws(() => parseOptionalSelection({ "transaction-binding": {} }, catalog), /optional feature "transaction-binding" is not supported/);
});

test("a scope the publisher did not select is refused at /authorize with a redirected invalid_scope", async () => {
  // Regression: since the CLI split routes/authorize.ts from its page layer, the scope
  // enforcement patch has to return an authorization_response outcome rather than call
  // c.redirect(), or the refusal is mistaken for a normal outcome and the request fails.
  const { fetch: fetchWorker } = await unbound.client();
  const authorizeUrl = new URL(`${unbound.issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid address", state: "scope-state", code_challenge: "x".repeat(43), code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, config.redirect_url);
  assert.equal(location.searchParams.get("error"), "invalid_scope");
  assert.equal(location.searchParams.get("state"), "scope-state");
});
