import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";

const opId = "maronn-op-test123456";
const generated = await generateOp(opId, path.resolve("test/fixtures/op-config.json"));

test("OP generation runs the pinned @maronn-oidc CLI with Hono and records provenance", async () => {
  const metadata = JSON.parse(await readFile(path.join(generated.appDirectory, "op.json"), "utf8"));
  assert.equal(metadata.framework, "hono");
  assert.equal(metadata.generator, "@maronn-oidc/cli@0.0.1");
  assert.equal(metadata.core, "@maronn-oidc/core@0.0.1");
  assert.deepEqual(metadata.scopes, ["openid", "profile", "email"]);
});

test("feature selections alter CLI output", async () => {
  const apply = await readFile(path.join(generated.appDirectory, "src/oidc-provider/apply.ts"), "utf8");
  assert.doesNotMatch(apply, /introspectionApp/);
  assert.match(apply, /revocationApp/);
  assert.match(apply, /@maronn-oidc\/core/);
});

test("Cloudflare overlay has no in-memory fallback and enforces selected scopes", async () => {
  const store = await readFile(path.join(generated.appDirectory, "src/oidc-provider/store.ts"), "utf8");
  const persistence = await readFile(path.join(generated.appDirectory, "src/oidc-provider/persistence.ts"), "utf8");
  const authorize = await readFile(path.join(generated.appDirectory, "src/oidc-provider/routes/authorize.ts"), "utf8");
  const discovery = await readFile(path.join(generated.appDirectory, "src/oidc-provider/routes/discovery.ts"), "utf8");
  assert.doesNotMatch(store, /new Map/);
  assert.match(store, /D1 OIDC runtime was not injected/);
  assert.match(persistence, /oidc_records/);
  assert.match(authorize, /Unsupported scope/);
  assert.match(discovery, /allowedScopes/);
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
