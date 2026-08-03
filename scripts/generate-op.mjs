#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { OP_ID_PATTERN, ROOT, readExperimentalCatalog, supportedExperimentalFeatures } from "./lib.mjs";

const execFile = promisify(execFileCallback);
const FEATURES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"];

function parseConfig(text, opId) {
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("OP config is not valid JSON"); }
  if (config.op_id !== opId) throw new Error("OP config op_id does not match");
  if (!config.features || FEATURES.some((name) => typeof config.features[name] !== "boolean")) throw new Error("OP feature configuration is invalid");
  if (!Array.isArray(config.scopes) || config.scopes[0] !== "openid") throw new Error("OP scope configuration is invalid");
  return config;
}

/**
 * Validates the experimental selection against experimental-features.json. Unknown ids
 * and options are rejected rather than ignored so a stale portal cannot silently produce
 * an OP whose advertised feature set is not actually generated.
 */
export function parseExperimentalSelection(value, catalog) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("experimental selection must be an object");
  const supported = new Map(supportedExperimentalFeatures(catalog).map((feature) => [feature.id, feature]));
  const selection = {};
  for (const [id, rawOptions] of Object.entries(value)) {
    const feature = supported.get(id);
    if (!feature) throw new Error(`experimental feature ${JSON.stringify(id)} is not supported`);
    if (rawOptions === undefined || rawOptions === null) { selection[id] = {}; continue; }
    if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) throw new Error(`experimental feature ${JSON.stringify(id)} options must be an object`);
    const declared = new Map((feature.options ?? []).map((option) => [option.id, option]));
    const options = {};
    for (const [optionId, optionValue] of Object.entries(rawOptions)) {
      const declaredOption = declared.get(optionId);
      if (!declaredOption) throw new Error(`experimental option ${JSON.stringify(`${id}.${optionId}`)} is not supported`);
      if (typeof optionValue !== "boolean") throw new Error(`experimental option ${JSON.stringify(`${id}.${optionId}`)} must be true or false`);
      options[optionId] = optionValue;
    }
    for (const [optionId, declaredOption] of declared) {
      if (!(optionId in options)) options[optionId] = declaredOption.default === true;
    }
    selection[id] = options;
  }
  return selection;
}

const EXPERIMENTAL_PLACEHOLDERS = {
  import: "// <!-- EXPERIMENTAL_IMPORT_PLACEHOLDER -->",
  runtime: "  // <!-- EXPERIMENTAL_RUNTIME_PLACEHOLDER -->",
  context: "    // <!-- EXPERIMENTAL_CONTEXT_PLACEHOLDER -->",
  route: "  // <!-- EXPERIMENTAL_ROUTE_PLACEHOLDER -->",
};

const EXPERIMENTAL_WIRING = {
  par: {
    import: "import { createParApp, createParRuntime, parDiscoveryMetadata, PAR_ENDPOINT_PATH } from './oidc-provider/experimental/par.js';",
    runtime: "  const parRuntime = createParRuntime({ store: runtime.pushedAuthorizationRequestStore, clientResolver: runtime.clientResolver, allowedScopes: scopes, options: experimental.par });",
    context: "    c.set('parRuntime', parRuntime);\n    c.set('experimentalDiscoveryMetadata', parDiscoveryMetadata(env.OP_ISSUER, parRuntime));",
    route: "  app.route(PAR_ENDPOINT_PATH, createParApp());",
    files: ["par.ts"],
  },
};

function replaceOnce(source, marker, replacement, description) {
  if (!source.includes(marker)) throw new Error(`${description} does not contain the expected marker`);
  return source.replace(marker, replacement);
}

/** Wires the selected experimental features into the Cloudflare entrypoint. */
async function applyExperimentalWiring(sourceDirectory, providerDirectory, featureIds) {
  const sections = { import: [], runtime: [], context: [], route: [] };
  const files = new Set(["core-compat.ts"]);
  for (const id of featureIds) {
    const wiring = EXPERIMENTAL_WIRING[id];
    if (!wiring) throw new Error(`experimental feature ${JSON.stringify(id)} has no generator wiring; see docs/experimental.md`);
    for (const key of ["import", "runtime", "context", "route"]) sections[key].push(wiring[key]);
    for (const file of wiring.files) files.add(file);
  }

  const experimentalDirectory = path.join(providerDirectory, "experimental");
  await mkdir(experimentalDirectory, { recursive: true });
  for (const file of files) {
    await cp(path.join(ROOT, "templates", "cloudflare", "experimental", file), path.join(experimentalDirectory, file));
  }

  const indexPath = path.join(sourceDirectory, "index.ts");
  let index = await readFile(indexPath, "utf8");
  for (const [key, marker] of Object.entries(EXPERIMENTAL_PLACEHOLDERS)) {
    index = replaceOnce(index, marker, sections[key].join("\n"), "Cloudflare entrypoint template");
  }
  await writeFile(indexPath, index);

  const authorizePath = path.join(providerDirectory, "routes", "authorize.ts");
  let authorize = await readFile(authorizePath, "utf8");
  authorize = replaceOnce(
    authorize,
    "import { defaultViews, renderView } from '../views.js';",
    "import { defaultViews, renderView } from '../views.js';\nimport { resolvePushedAuthorizationParams } from '../experimental/par.js';",
    "generated authorize.ts",
  );
  authorize = replaceOnce(
    authorize,
    "  const params = rawParams;",
    [
      "  // Experimental (RFC 9126 §4): swap a pushed request_uri for the parameters stored",
      "  // at /par before validation, so only what the client pushed is honoured.",
      "  const pushedRequest = await resolvePushedAuthorizationParams(c.get('parRuntime'), rawParams);",
      "  if (!pushedRequest.ok) {",
      "    return c.json({ error: pushedRequest.error, error_description: pushedRequest.errorDescription }, 400);",
      "  }",
      "  const params = pushedRequest.params as typeof rawParams;",
    ].join("\n"),
    "generated authorize.ts",
  );
  await writeFile(authorizePath, authorize);

  const discoveryPath = path.join(providerDirectory, "routes", "discovery.ts");
  let discovery = await readFile(discoveryPath, "utf8");
  discovery = replaceOnce(
    discovery,
    "    code_challenge_methods_supported: ['S256'],",
    "    code_challenge_methods_supported: ['S256'],\n    ...((c.get('experimentalDiscoveryMetadata') as Record<string, unknown> | undefined) ?? {}),",
    "generated discovery.ts",
  );
  await writeFile(discoveryPath, discovery);
}

async function patchGeneratedSource(providerDirectory) {
  const loginPath = path.join(providerDirectory, "routes", "login.ts");
  let login = await readFile(loginPath, "utf8");
  login = login.replace("if (existingSessionId) browserSessionStore.delete(existingSessionId);", "if (existingSessionId) await browserSessionStore.delete(existingSessionId);");
  login = login.replace("  browserSessionStore.set(sessionId, { subject: user.sub, authTime });", "  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });");
  await writeFile(loginPath, login);

  const authorizePath = path.join(providerDirectory, "routes", "authorize.ts");
  let authorize = await readFile(authorizePath, "utf8");
  const marker = "    // Create authentication transaction";
  if (!authorize.includes(marker)) throw new Error("generated authorize.ts does not contain the expected CLI marker");
  authorize = authorize.replace(marker, `    // Enforce the scopes selected in the publisher UI.\n    const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n    const unsupportedScopes = validatedRequest.scope.filter((scope) => !allowedScopes.includes(scope));\n    if (unsupportedScopes.length > 0) {\n      return c.redirect(buildErrorRedirect(validatedRequest.redirectUri, 'invalid_scope', validatedRequest.state, 'Unsupported scope: ' + unsupportedScopes.join(' '), issuer));\n    }\n\n${marker}`);
  await writeFile(authorizePath, authorize);

  const discoveryPath = path.join(providerDirectory, "routes", "discovery.ts");
  let discovery = await readFile(discoveryPath, "utf8");
  const scopeLiteral = /scopesSupported: \['openid', 'profile', 'email', 'address', 'phone'(?:, 'offline_access')?\],/;
  if (!scopeLiteral.test(discovery)) throw new Error("generated discovery.ts does not contain the expected scopes marker");
  discovery = discovery.replace(scopeLiteral, "scopesSupported: (c.get('allowedScopes') as string[] | undefined) ?? ['openid'],");
  await writeFile(discoveryPath, discovery);
}

export async function generateOp(opId, configPath) {
  if (!OP_ID_PATTERN.test(opId)) throw new Error("invalid op_id");
  const config = parseConfig(await readFile(configPath, "utf8"), opId);
  const appDirectory = path.join(ROOT, "apps", opId);
  const sourceDirectory = path.join(appDirectory, "src");
  const providerDirectory = path.join(sourceDirectory, "oidc-provider");
  await mkdir(providerDirectory, { recursive: true });

  const rootPackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const cliPackage = rootPackage.config?.maronnOidcCli;
  if (typeof cliPackage !== "string" || !/^@maronn-oidc\/cli@\d+\.\d+\.\d+$/.test(cliPackage)) throw new Error("package.json config.maronnOidcCli must be an exact package version");
  const catalog = await readExperimentalCatalog();
  const experimental = parseExperimentalSelection(config.experimental, catalog);
  const experimentalIds = Object.keys(experimental);
  const disabled = FEATURES.filter((name) => config.features[name] === false);
  const args = ["exec", "--yes", `--package=${cliPackage}`, "--", "maronn-oidc", "generate", "hono", "--output", providerDirectory];
  if (disabled.length > 0) args.push("--disable", disabled.join(","));
  await execFile("npm", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });

  await cp(path.join(ROOT, "templates", "cloudflare", "store.ts"), path.join(providerDirectory, "store.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "resolvers.ts"), path.join(providerDirectory, "resolvers.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "persistence.ts"), path.join(providerDirectory, "persistence.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "index.ts"), path.join(sourceDirectory, "index.ts"));
  await patchGeneratedSource(providerDirectory);
  if (experimentalIds.length > 0) await applyExperimentalWiring(sourceDirectory, providerDirectory, experimentalIds);

  const metadata = {
    op_id: opId,
    name: config.name,
    framework: "hono",
    generator: cliPackage,
    core: rootPackage.config.maronnOidcCore,
    redirect_url: config.redirect_url,
    client_type: config.client_type,
    client_id: config.client_id,
    scopes: config.scopes,
    features: config.features,
    experimental,
    ...(experimentalIds.length > 0 ? { experimental_package: rootPackage.config.maronnOidcExperimental } : {}),
    generated_at: new Date().toISOString(),
  };
  await writeFile(path.join(appDirectory, "op.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { appDirectory, entryPoint: path.join(sourceDirectory, "index.ts"), config, cliPackage, experimental };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [opId, configPath] = process.argv.slice(2);
  if (!opId || !configPath) throw new Error("usage: node scripts/generate-op.mjs <op_id> <config.json>");
  generateOp(opId, path.resolve(configPath)).then(({ appDirectory }) => process.stdout.write(`${appDirectory}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
