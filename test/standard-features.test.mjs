import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { clientGrantTypes } from "../scripts/deploy-op.mjs";
import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";
import { MemoryD1, signingEnvironment } from "./support/d1-mock.mjs";

const opId = "maronn-op-flows123456";
const issuer = `https://${opId}.example.workers.dev`;

async function discoveryOf(configPath) {
  const generated = await generateOp(opId, path.resolve(configPath));
  const code = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "standard-features-worker-"));
  const modulePath = path.join(temporary, "worker.mjs");
  await writeFile(modulePath, code);
  const worker = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
  const keyPair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const env = {
    DB: { prepare() { throw new Error("discovery must not query D1"); }, batch() { throw new Error("discovery must not query D1"); } },
    OP_ID: opId,
    OP_ISSUER: issuer,
    ALLOWED_SCOPES: JSON.stringify(["openid", "profile", "email"]),
    OIDC_SIGNING_JWK: JSON.stringify({ ...privateJwk, alg: "RS256", use: "sig", kid: "test-key" }),
    OIDC_CLIENT_CONFIG: JSON.stringify({ clientId: "client_test123456789", clientSecret: "test-secret-that-is-long-enough-for-validation", redirectUris: ["https://client.example/callback"], clientType: "confidential", grantTypes: ["authorization_code"], tokenEndpointAuthMethods: ["client_secret_post"] }),
  };
  const response = await worker.default.fetch(new Request(`${issuer}/.well-known/openid-configuration`), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  return response.json();
}

test("form-post-response-mode, implicit-flow and hybrid-flow are generated and advertised when selected", async () => {
  const on = await discoveryOf("test/fixtures/op-config-flows.json");
  assert.ok(on.grant_types_supported.includes("client_credentials"));
  assert.ok(on.response_modes_supported.includes("form_post"));
  assert.ok(on.response_modes_supported.includes("fragment"));
  assert.ok(on.response_types_supported.includes("id_token"));
  assert.ok(on.response_types_supported.includes("code id_token"));
  assert.deepEqual(on.scopes_supported, ["openid", "profile", "email"]);

});

// client-credentials became a standard (default-on) feature in cli 0.17.0.
const m2mConfig = {
  op_id: "maronn-op-m2m123456789",
  name: "M2M OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_m2m1234567890",
  client_secret: "m2m-secret-that-is-long-enough-for-testing",
  scopes: ["openid", "profile", "reports.read"],
  features: { pkce: true, "refresh-token": false, "client-credentials": true, introspection: false, revocation: false, "request-object": false, "form-post-response-mode": false, "implicit-flow": false, "hybrid-flow": false },
};

async function m2mWorker(config) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "client-credentials-worker-"));
  const configPath = path.join(temporary, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const generated = await generateOp(config.op_id, configPath);
  const modulePath = path.join(temporary, "worker.mjs");
  await writeFile(modulePath, await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory }));
  const worker = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
  const opIssuer = `https://${config.op_id}.example.workers.dev`;
  const env = await signingEnvironment(opIssuer, config.op_id, config, new MemoryD1());
  const token = (fields) => worker.default.fetch(new Request(`${opIssuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.client_id, ...(config.client_secret ? { client_secret: config.client_secret } : {}), ...fields }) }), env, { waitUntil() {}, passThroughOnException() {} });
  const discovery = await (await worker.default.fetch(new Request(`${opIssuer}/.well-known/openid-configuration`), env, { waitUntil() {}, passThroughOnException() {} })).json();
  return { token, discovery };
}

test("client-credentials issues an access token to the confidential client, within the publisher's scopes", async () => {
  const { token, discovery } = await m2mWorker(m2mConfig);
  assert.ok(discovery.grant_types_supported.includes("client_credentials"));

  const issued = await token({ scope: "profile reports.read" });
  assert.equal(issued.status, 200, await issued.clone().text());
  const body = await issued.json();
  assert.ok(body.access_token);
  assert.equal(body.scope, "profile reports.read");
  // RFC 6749 §4.4.3: no refresh token; and no end user, so no ID Token either.
  assert.equal("refresh_token" in body, false);
  assert.equal("id_token" in body, false);

  // `email` is a scope the generated OP knows, but the publisher did not select it.
  const unselected = await token({ scope: "email" });
  assert.equal(unselected.status, 400);
  assert.equal((await unselected.json()).error, "invalid_scope");

  const wrongSecret = await token({ client_secret: "not-the-secret-not-the-secret-not-the-secret" });
  assert.equal(wrongSecret.status, 401);
});

test("client-credentials is not offered when switched off, and never registered for a public client", async () => {
  const off = await m2mWorker({ ...m2mConfig, op_id: "maronn-op-m2moff1234567", features: { ...m2mConfig.features, "client-credentials": false } });
  assert.equal(off.discovery.grant_types_supported.includes("client_credentials"), false);
  const refused = await off.token({ scope: "profile" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "unsupported_grant_type");

  assert.deepEqual(clientGrantTypes(m2mConfig.features, {}, "confidential"), ["authorization_code", "client_credentials"]);
  assert.deepEqual(clientGrantTypes(m2mConfig.features, {}, "public"), ["authorization_code"]);
  assert.deepEqual(clientGrantTypes({ ...m2mConfig.features, "client-credentials": false }, {}, "confidential"), ["authorization_code"]);
});
