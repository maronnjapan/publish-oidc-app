import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OP_ID_PATTERN = /^maronn-op-[a-z0-9]{10,16}$/;
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export async function readInfra() {
  let infra;
  try {
    infra = JSON.parse(await readFile(path.join(ROOT, "infra.json"), "utf8"));
  } catch (error) {
    throw new Error(`unable to read infra.json: ${error.message}`);
  }
  for (const field of [
    "account_id",
    "workers_dev_subdomain",
    "d1_database_id",
    "compatibility_date",
    "github_owner",
    "github_repo",
  ]) {
    if (typeof infra[field] !== "string" || !infra[field]) {
      throw new Error(`infra.json field ${field} must be a non-empty string`);
    }
  }
  return infra;
}

export const EXPERIMENTAL_CATALOG_PATH = path.join(ROOT, "experimental-features.json");
export const OPTIONAL_CATALOG_PATH = path.join(ROOT, "optional-features.json");

export const FEATURE_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * The CLI ships feature toggles in three groups, and this repository follows all three:
 * the default set (always generated unless disabled), CLI-native optional features, and
 * the experimental features that live in a separate package. The two opt-in groups get a
 * catalog file each, with the same shape, so adding a group member is data plus wiring
 * rather than a new code path.
 */
async function readFeatureCatalog(catalogPath, kind) {
  const fileName = path.basename(catalogPath);
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${fileName}: ${error.message}`);
  }
  if (!Array.isArray(catalog?.features)) throw new Error(`${fileName} must contain a features array`);
  for (const feature of catalog.features) {
    if (typeof feature?.id !== "string" || !FEATURE_ID_PATTERN.test(feature.id)) {
      throw new Error(`every ${kind} feature needs a lowercase id`);
    }
    if (feature.status !== "supported" && feature.status !== "detected") {
      throw new Error(`${kind} feature ${feature.id} must be status supported or detected`);
    }
  }
  return catalog;
}

/** Single source of truth for @maronn-openid-connect/experimental features (see docs/experimental.md). */
export async function readExperimentalCatalog() {
  return readFeatureCatalog(EXPERIMENTAL_CATALOG_PATH, "experimental");
}

/** Single source of truth for the CLI's own opt-in features (see docs/optional-features.md). */
export async function readOptionalCatalog() {
  return readFeatureCatalog(OPTIONAL_CATALOG_PATH, "optional");
}

/** Features that are wired into the generator, i.e. the ones the portal may offer. */
export function supportedFeatures(catalog) {
  return catalog.features.filter((feature) => feature.status === "supported");
}

function describeErrors(payload, status) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return payload.errors.map((error) => error.message ?? error.code).join("; ");
  }
  return `HTTP ${status}`;
}

export async function apiRequest(url, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Some successful Cloudflare endpoints return an empty/non-JSON body.
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`Cloudflare API request failed (${url}): ${describeErrors(payload, response.status)}`);
  }
  return { response, payload, result: payload?.result };
}

export function accountUrl(infra, suffix) {
  const base = (process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return `${base}/accounts/${encodeURIComponent(infra.account_id)}${suffix}`;
}

export async function d1Query(infra, token, sql, params = []) {
  const { result } = await apiRequest(
    accountUrl(infra, `/d1/database/${encodeURIComponent(infra.d1_database_id)}/query`),
    token,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  const first = Array.isArray(result) ? result[0] : result;
  if (!first?.success) throw new Error(first?.error ?? first?.errors?.[0]?.message ?? "D1 query failed");
  return first;
}

export function getD1Rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function bundle(entryPoint, options = {}) {
  const output = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    target: "es2022",
    legalComments: "none",
    ...options,
  });
  if (!output.outputFiles[0]) throw new Error(`esbuild produced no output for ${entryPoint}`);
  return output.outputFiles[0].text;
}

export async function uploadWorker(infra, token, scriptName, code, bindings) {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: infra.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
  const body = new FormData();
  body.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  body.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
  await apiRequest(accountUrl(infra, `/workers/scripts/${encodeURIComponent(scriptName)}`), token, {
    method: "PUT",
    body,
  });
}

export async function setWorkerSecret(infra, token, scriptName, name, secretText) {
  await apiRequest(accountUrl(infra, `/workers/scripts/${encodeURIComponent(scriptName)}/secrets`), token, {
    method: "PUT",
    body: JSON.stringify({ name, text: secretText, type: "secret_text" }),
  });
}

export async function setSubdomain(infra, token, scriptName, enabled = true) {
  await apiRequest(accountUrl(infra, `/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`), token, {
    method: "POST",
    body: JSON.stringify({ enabled, previews_enabled: false }),
  });
}

export function workerUrl(infra, scriptName) {
  return `https://${scriptName}.${infra.workers_dev_subdomain}.workers.dev`;
}
