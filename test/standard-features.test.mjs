import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { generateOp } from "../scripts/generate-op.mjs";
import { bundle } from "../scripts/lib.mjs";

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
  assert.ok(on.response_modes_supported.includes("form_post"));
  assert.ok(on.response_modes_supported.includes("fragment"));
  assert.ok(on.response_types_supported.includes("id_token"));
  assert.ok(on.response_types_supported.includes("code id_token"));
  assert.deepEqual(on.scopes_supported, ["openid", "profile", "email"]);

});
