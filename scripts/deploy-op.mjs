#!/usr/bin/env node

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  OP_ID_PATTERN,
  bundle,
  d1Query,
  getD1Rows,
  readInfra,
  requireEnv,
  setSubdomain,
  setWorkerSecret,
  uploadWorker,
  workerUrl,
} from "./lib.mjs";
import { generateOp } from "./generate-op.mjs";

const FEATURES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"];

function parseRequestConfig(row, opId) {
  if (!row || row.op_id !== opId || typeof row.config_json !== "string") throw new Error("deployment request/config was not found");
  let config;
  try { config = JSON.parse(row.config_json); } catch { throw new Error("deployment config is invalid JSON"); }
  if (typeof config.client_id !== "string" || !/^client_[A-Za-z0-9_-]{12,64}$/.test(config.client_id)) throw new Error("client_id is invalid");
  if (config.client_type !== "public" && config.client_type !== "confidential") throw new Error("client_type is invalid");
  if (config.client_type === "confidential" && (typeof config.client_secret !== "string" || config.client_secret.length < 32)) throw new Error("confidential client secret is missing");
  if (!Array.isArray(config.scopes) || config.scopes[0] !== "openid") throw new Error("scopes are invalid");
  if (!config.features || FEATURES.some((feature) => typeof config.features[feature] !== "boolean")) throw new Error("features are invalid");
  if (config.experimental !== undefined && (typeof config.experimental !== "object" || config.experimental === null || Array.isArray(config.experimental))) throw new Error("experimental selection is invalid");
  if (config.optional !== undefined && (typeof config.optional !== "object" || config.optional === null || Array.isArray(config.optional))) throw new Error("optional selection is invalid");
  return { ...config, op_id: opId };
}

export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The generated OP authorizes a grant against the client's registered grantTypes, so an
 * experimental grant has to be registered alongside the standard ones or every exchange
 * comes back unauthorized_client.
 */
export function clientGrantTypes(features, experimental = {}) {
  const grantTypes = ["authorization_code"];
  if (features["refresh-token"]) grantTypes.push("refresh_token");
  if (experimental["token-exchange"]) grantTypes.push(TOKEN_EXCHANGE_GRANT_TYPE);
  if (experimental["device-authorization-grant"]) grantTypes.push(DEVICE_CODE_GRANT_TYPE);
  return grantTypes;
}

async function createSigningJwk() {
  const pair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ ...jwk, alg: "RS256", use: "sig", kid: webcrypto.randomUUID() });
}

export async function deployOp(opId) {
  if (!OP_ID_PATTERN.test(opId)) throw new Error("invalid op_id");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const infra = await readInfra();
  const query = await d1Query(infra, token, `SELECT request_id, op_id, name, config_json FROM registry_requests WHERE op_id = ?1 AND status IN ('pending', 'generating')`, [opId]);
  const row = getD1Rows(query)[0];
  const config = parseRequestConfig(row, opId);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "maronn-op-config-"));
  const configPath = path.join(temporary, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const generated = await generateOp(opId, configPath);
  const code = await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory });
  const issuer = workerUrl(infra, opId);
  const client = {
    clientId: config.client_id,
    ...(config.client_type === "confidential" ? { clientSecret: config.client_secret } : {}),
    redirectUris: [config.redirect_url],
    clientType: config.client_type,
    offlineAccessAllowed: config.scopes.includes("offline_access"),
    grantTypes: clientGrantTypes(config.features, generated.experimental),
    tokenEndpointAuthMethod: config.client_type === "public" ? "none" : "client_secret_post",
  };
  await uploadWorker(infra, token, opId, code, [
    { type: "d1", name: "DB", id: infra.d1_database_id },
    { type: "plain_text", name: "OP_ID", text: opId },
    { type: "plain_text", name: "OP_ISSUER", text: issuer },
    { type: "plain_text", name: "ALLOWED_SCOPES", text: JSON.stringify(config.scopes) },
  ]);
  await setWorkerSecret(infra, token, opId, "OIDC_SIGNING_JWK", await createSigningJwk());
  await setWorkerSecret(infra, token, opId, "OIDC_CLIENT_CONFIG", JSON.stringify(client));
  await setSubdomain(infra, token, opId);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  await d1Query(infra, token, `INSERT INTO registry_ops (op_id, script_name, name, url, client_id, client_type, redirect_uri, scopes_json, features_json, created_at, expires_at, status) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active') ON CONFLICT(op_id) DO UPDATE SET url = excluded.url, created_at = excluded.created_at, expires_at = excluded.expires_at, status = 'active'`, [opId, config.name || opId, issuer, config.client_id, config.client_type, config.redirect_url, JSON.stringify(config.scopes), JSON.stringify({ ...config.features, optional: generated.optional, experimental: generated.experimental }), now, expiresAt]);
  const sanitizedConfig = { ...config };
  delete sanitizedConfig.client_secret;
  await d1Query(infra, token, `UPDATE registry_requests SET status = 'deployed', url = ?2, error = NULL, config_json = ?3, updated_at = ?4 WHERE request_id = ?1`, [row.request_id, issuer, JSON.stringify(sanitizedConfig), now]);
  return { opId, issuer, clientId: config.client_id, clientType: config.client_type, optional: Object.keys(generated.optional), experimental: Object.keys(generated.experimental) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const opId = process.argv[2];
  if (!opId) {
    process.stderr.write("usage: node scripts/deploy-op.mjs <op_id>\n");
    process.exitCode = 1;
  } else {
    deployOp(opId).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
