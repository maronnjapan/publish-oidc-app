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
export const CHOICE_CATALOG_PATH = path.join(ROOT, "portal-choices.json");

export const FEATURE_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/** A one-line summary is a promise about the rendering: one sentence, one line, no markup. */
const SUMMARY_MAX_LENGTH = 120;

/**
 * A reference attached to a selectable item. Links are optional everywhere, but a link that
 * is written must resolve: either an absolute https URL or `doc`, a path to a Markdown file
 * in this repository that the portal turns into a GitHub URL (see docs/choices.md).
 */
export function validateLinks(links, where) {
  if (links === undefined) return [];
  if (!Array.isArray(links)) throw new Error(`${where} links must be an array`);
  for (const link of links) {
    if (!link || typeof link.label !== "string" || link.label.trim() === "") throw new Error(`${where} link needs a label`);
    const hasUrl = typeof link.url === "string" && link.url.length > 0;
    const hasDoc = typeof link.doc === "string" && link.doc.length > 0;
    if (hasUrl === hasDoc) throw new Error(`${where} link ${JSON.stringify(link.label)} needs exactly one of url or doc`);
    if (hasUrl && !link.url.startsWith("https://")) throw new Error(`${where} link ${JSON.stringify(link.label)} must be an https URL`);
    if (hasDoc && (link.doc.startsWith("/") || link.doc.includes(".."))) throw new Error(`${where} link ${JSON.stringify(link.label)} doc must be a path inside this repository`);
  }
  return links;
}

/**
 * Single source of truth for the one-line summaries and reference links of the choices the
 * portal offers itself: client type, scopes, and the CLI's default feature toggles. The two
 * opt-in catalogs carry their own, in the same `summary` + `links` shape.
 */
export async function readChoiceCatalog() {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(CHOICE_CATALOG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`unable to read portal-choices.json: ${error.message}`);
  }
  if (!Array.isArray(catalog?.groups)) throw new Error("portal-choices.json must contain a groups array");
  const groupIds = new Set();
  for (const group of catalog.groups) {
    if (typeof group?.id !== "string" || !group.id) throw new Error("every choice group needs an id");
    if (groupIds.has(group.id)) throw new Error(`choice group ${group.id} is declared twice`);
    groupIds.add(group.id);
    if (!Array.isArray(group.items) || group.items.length === 0) throw new Error(`choice group ${group.id} needs items`);
    const itemIds = new Set();
    for (const item of group.items) {
      const where = `choice ${group.id}.${item?.id}`;
      if (typeof item?.id !== "string" || !item.id) throw new Error(`every item of ${group.id} needs an id`);
      if (itemIds.has(item.id)) throw new Error(`${where} is declared twice`);
      itemIds.add(item.id);
      if (typeof item.label !== "string" || !item.label) throw new Error(`${where} needs a label`);
      if (typeof item.summary !== "string" || item.summary.trim() === "") throw new Error(`${where} needs a summary`);
      if (/[\r\n]/.test(item.summary)) throw new Error(`${where} summary must stay on one line`);
      if (item.summary.length > SUMMARY_MAX_LENGTH) throw new Error(`${where} summary must be ${SUMMARY_MAX_LENGTH} characters or fewer`);
      validateLinks(item.links, where);
    }
  }
  return catalog;
}

/** The items of one choice group, in display order. */
export function choiceGroup(catalog, groupId) {
  const group = catalog.groups.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`portal-choices.json has no group ${JSON.stringify(groupId)}`);
  return group;
}

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
    validateLinks(feature.links, `${kind} feature ${feature.id}`);
    for (const option of feature.options ?? []) {
      validateLinks(option.links, `${kind} option ${feature.id}.${option?.id}`);
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
    // The UI is Japanese. Left on esbuild's default the whole of it ships as \uXXXX escapes,
    // which doubles those literals and gives the isolate more source to parse at startup.
    charset: "utf8",
    // platform:"browser" makes esbuild refuse to resolve node builtins outright, which would
    // fail the build before the runtime's nodejs_compat could handle them. Uploads declare
    // that flag, so leave such imports for workerd rather than for esbuild.
    external: ["node:*", ...(options.external ?? [])],
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
