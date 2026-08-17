import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";

const opId = "maronn-op-test123456";
const generated = await generateOp(opId, path.resolve("test/fixtures/op-config.json"));

test("OP generation runs the pinned @maronn-openid-connect CLI with Hono and records provenance", async () => {
  const metadata = JSON.parse(await readFile(path.join(generated.appDirectory, "op.json"), "utf8"));
  assert.equal(metadata.framework, "hono");
  assert.equal(metadata.generator, "@maronn-openid-connect/cli@0.3.0");
  assert.equal(metadata.core, "@maronn-openid-connect/core@0.1.1");
  assert.deepEqual(metadata.scopes, ["openid", "profile", "email"]);
});

test("feature selections alter CLI output", async () => {
  const apply = await readFile(path.join(generated.appDirectory, "src/oidc-provider/apply.ts"), "utf8");
  assert.doesNotMatch(apply, /introspectionApp/);
  assert.match(apply, /revocationApp/);
  assert.match(apply, /@maronn-openid-connect\/core/);
});

test("the D1 overlay backs every store and the selected scopes are enforced", async () => {
  const store = await readFile(path.join(generated.appDirectory, "src/oidc-provider/store.ts"), "utf8");
  const persistence = await readFile(path.join(generated.appDirectory, "src/oidc-provider/persistence.ts"), "utf8");
  const authorize = await readFile(path.join(generated.appDirectory, "src/oidc-provider/routes/authorize.ts"), "utf8");
  const discovery = await readFile(path.join(generated.appDirectory, "src/oidc-provider/routes/discovery.ts"), "utf8");
  const index = await readFile(path.join(generated.appDirectory, "src/index.ts"), "utf8");
  assert.match(persistence, /oidc_records/);
  assert.match(index, /storage: \(\) => createD1ProviderStores/, "applyOidc must be given the D1 stores, never the generated defaults");
  assert.match(authorize, /Unsupported scope/);
  assert.match(discovery, /allowedScopes/);
  // Both of the CLI's development fixture paths are disarmed.
  assert.match(store, /accounts come from the shared D1 only/);
  assert.match(store, /must never authenticate on a published OP/);
});

test("the generated app carries a tsconfig that checks the overlay against the store contract", async () => {
  const tsconfig = JSON.parse(await readFile(path.join(generated.appDirectory, "tsconfig.json"), "utf8"));
  assert.deepEqual(tsconfig.include, ["src/oidc-provider/persistence.ts"]);
  await execFile("npx", ["tsc", "-p", generated.appDirectory], { cwd: process.cwd() });
});

test("an OP without experimental features references neither the package nor its routes", async () => {
  const authorize = await readFile(path.join(generated.appDirectory, "src/oidc-provider/routes/authorize.ts"), "utf8");
  assert.doesNotMatch(authorize, /experimental/);
  assert.equal(existsSync(path.join(generated.appDirectory, "src/oidc-provider/routes/par.ts")), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(generated.appDirectory, "op.json"), "utf8")).experimental, {});
  const code = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  assert.doesNotMatch(code, /urn:ietf:params:oauth:request_uri:/);
});

test("generated OP bundles for the Workers runtime", async () => {
  const code = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  assert.ok(code.length > 100_000);
  assert.match(code, /openid-configuration/);
});

test("generated Worker serves discovery with selected features and scopes", async () => {
  const code = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "generated-oidc-worker-"));
  const modulePath = path.join(temporary, "worker.mjs");
  await writeFile(modulePath, code);
  const worker = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
  const keyPair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const issuer = "https://maronn-op-test123456.example.workers.dev";
  const runtimeEnv = {
    DB: { prepare() { throw new Error("discovery must not query D1"); }, batch() { throw new Error("discovery must not query D1"); } },
    OP_ID: opId,
    OP_ISSUER: issuer,
    ALLOWED_SCOPES: JSON.stringify(["openid", "profile", "email"]),
    OIDC_SIGNING_JWK: JSON.stringify({ ...privateJwk, alg: "RS256", use: "sig", kid: "test-key" }),
    OIDC_CLIENT_CONFIG: JSON.stringify({ clientId: "client_test123456789", clientSecret: "test-secret-that-is-long-enough-for-validation", redirectUris: ["https://client.example/callback"], clientType: "confidential", grantTypes: ["authorization_code"], tokenEndpointAuthMethod: "client_secret_post" }),
  };
  const response = await worker.default.fetch(new Request(`${issuer}/.well-known/openid-configuration`), runtimeEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, issuer);
  assert.deepEqual(metadata.scopes_supported, ["openid", "profile", "email"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code"]);
  assert.equal("introspection_endpoint" in metadata, false);
  assert.equal(metadata.revocation_endpoint, `${issuer}/revoke`);
});
