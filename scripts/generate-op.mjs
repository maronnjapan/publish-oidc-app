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
    if (rawOptions !== undefined && rawOptions !== null && (typeof rawOptions !== "object" || Array.isArray(rawOptions))) throw new Error(`experimental feature ${JSON.stringify(id)} options must be an object`);
    const declared = new Map((feature.options ?? []).map((option) => [option.id, option]));
    const options = {};
    for (const [optionId, optionValue] of Object.entries(rawOptions ?? {})) {
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

/**
 * Per-feature adjustments applied after the CLI has generated the feature itself. The
 * CLI owns the routes and the discovery metadata; only settings the publisher UI exposes
 * are patched here.
 */
export const EXPERIMENTAL_WIRING = {
  par: {
    apply(sources, options) {
      // The generated PAR store is in-memory. Let the D1-backed one that the Worker
      // entrypoint seeds into context win (templates/cloudflare/index.ts).
      sources["apply.ts"] = replaceOnce(
        sources["apply.ts"],
        "    c.set('parStore', parStore);",
        "    c.set('parStore', c.get('parStore') ?? parStore);",
        "generated apply.ts",
      );
      // /authorize enforces the publisher's scope selection too, but a client that pushes
      // an unavailable scope should learn about it at push time rather than one redirect
      // later (RFC 9126 §2.1 validates as the authorization endpoint would).
      sources["routes/par.ts"] = replaceOnce(
        sources["routes/par.ts"],
        "    const pushedParams = { ...params, client_id: clientId };",
        "    const pushedParams = { ...params, client_id: clientId };\n\n    // Enforce the scopes selected in the publisher UI.\n    const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n    const unsupportedScopes = (pushedParams.scope ?? '').split(' ').filter((scope) => scope.length > 0 && !allowedScopes.includes(scope));\n    if (unsupportedScopes.length > 0) {\n      throw new ParError('invalid_scope', 'Unsupported scope: ' + unsupportedScopes.join(' '));\n    }",
        "generated routes/par.ts",
      );
      if (options.required) {
        sources["routes/par.ts"] = replaceOnce(
          sources["routes/par.ts"],
          "  requirePushedAuthorizationRequests: false,",
          "  requirePushedAuthorizationRequests: true,",
          "generated routes/par.ts",
        );
      }
    },
  },
  "token-exchange": {
    // RFC 8693 is generated whole by the CLI. allowedTargets stays empty (fail safe):
    // scope-narrowing and lifetime-shortening exchanges work, naming a target does not.
    apply() {},
  },
};

const EXPERIMENTAL_CONFIG_LINE = "const EXPERIMENTAL_FEATURES: Record<string, Record<string, unknown>> = {};";

function replaceOnce(source, marker, replacement, description) {
  if (!source.includes(marker)) throw new Error(`${description} does not contain the expected marker`);
  return source.replace(marker, replacement);
}

/**
 * Adjustments to the CLI output that every generated OP needs, whatever it selected.
 * Each one asserts its marker so a CLI upgrade that moves the ground under us fails the
 * build instead of silently producing an OP that ignores the publisher's choices.
 */
function patchGeneratedSource(sources) {
  const marker = "    // Create authentication transaction";
  sources["routes/authorize.ts"] = replaceOnce(
    sources["routes/authorize.ts"],
    marker,
    `    // Enforce the scopes selected in the publisher UI.\n    const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n    const unsupportedScopes = validatedRequest.scope.filter((scope) => !allowedScopes.includes(scope));\n    if (unsupportedScopes.length > 0) {\n      return c.redirect(buildErrorRedirect(validatedRequest.redirectUri, 'invalid_scope', validatedRequest.state, 'Unsupported scope: ' + unsupportedScopes.join(' '), issuer));\n    }\n\n${marker}`,
    "generated authorize.ts",
  );

  // offline_access drops out of the literal when the refresh-token feature is disabled.
  const scopeLiteral = /scopesSupported: \['openid', 'profile', 'email', 'address', 'phone'(?:, 'offline_access')?\],/;
  if (!scopeLiteral.test(sources["routes/discovery.ts"])) throw new Error("generated discovery.ts does not contain the expected scopes marker");
  sources["routes/discovery.ts"] = sources["routes/discovery.ts"].replace(
    scopeLiteral,
    "scopesSupported: (c.get('allowedScopes') as string[] | undefined) ?? ['openid'],",
  );

  // The publisher's accounts live in the shared D1. Neither fixture path may ever mint a
  // login: the CLI seeds a `testuser` account into both the JSON-backed and the
  // in-memory user store, which would otherwise be a valid account on any OP that fell
  // back to the generated defaults.
  sources["store.ts"] = replaceOnce(
    sources["store.ts"],
    "function defaultUserFixture(username: string): StoredUser | undefined {",
    "function defaultUserFixture(username: string): StoredUser | undefined {\n  // Publisher overlay: accounts come from the shared D1 only, never from a fixture.\n  if (username !== undefined) return undefined;",
    "generated store.ts",
  );
  sources["store.ts"] = replaceOnce(
    sources["store.ts"],
    "  authenticate(username: string, password: string): (UserClaims & { password: string }) | undefined {",
    "  authenticate(username: string, password: string): (UserClaims & { password: string }) | undefined {\n    // Publisher overlay: see defaultUserFixture above. The development fixtures this\n    // class seeds must never authenticate on a published OP.\n    if (username || password) return undefined;",
    "generated store.ts",
  );
}

/**
 * Type-checks the D1 overlay against the store contract the CLI just generated, which is
 * how a breaking change to JsonStoreBackend / ProviderStores / UserStorage surfaces at
 * build time instead of as a runtime failure in a deployed OP.
 *
 * Scoped to persistence.ts on purpose: the CLI's own route files iterate URLSearchParams,
 * which @cloudflare/workers-types does not type as iterable, so checking them here would
 * only report noise about code we do not own.
 */
const GENERATED_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2022", "WebWorker"],
    types: ["@cloudflare/workers-types"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/oidc-provider/persistence.ts"],
};

export async function generateOp(opId, configPath) {
  if (!OP_ID_PATTERN.test(opId)) throw new Error("invalid op_id");
  const config = parseConfig(await readFile(configPath, "utf8"), opId);
  const appDirectory = path.join(ROOT, "apps", opId);
  const sourceDirectory = path.join(appDirectory, "src");
  const providerDirectory = path.join(sourceDirectory, "oidc-provider");
  await mkdir(providerDirectory, { recursive: true });

  const rootPackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const cliPackage = rootPackage.config?.maronnOidcCli;
  if (typeof cliPackage !== "string" || !/^@maronn-openid-connect\/cli@\d+\.\d+\.\d+$/.test(cliPackage)) throw new Error("package.json config.maronnOidcCli must be an exact package version");
  const catalog = await readExperimentalCatalog();
  const experimental = parseExperimentalSelection(config.experimental, catalog);
  const experimentalIds = Object.keys(experimental);

  const disabled = FEATURES.filter((name) => config.features[name] === false);
  const args = ["exec", "--yes", `--package=${cliPackage}`, "--", "maronn-oidc", "generate", "hono", "--output", providerDirectory];
  if (disabled.length > 0) args.push("--disable", disabled.join(","));
  // Experimental features are off by default in the CLI and generated only on request.
  if (experimentalIds.length > 0) args.push("--enable", experimentalIds.join(","));
  await execFile("npm", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });

  const patched = ["apply.ts", "store.ts", "routes/authorize.ts", "routes/discovery.ts", ...(experimentalIds.includes("par") ? ["routes/par.ts"] : [])];
  const sources = Object.fromEntries(await Promise.all(
    patched.map(async (file) => [file, await readFile(path.join(providerDirectory, file), "utf8")]),
  ));
  patchGeneratedSource(sources);
  for (const id of experimentalIds) {
    const wiring = EXPERIMENTAL_WIRING[id];
    if (!wiring) throw new Error(`experimental feature ${JSON.stringify(id)} has no generator wiring; see docs/experimental.md`);
    wiring.apply(sources, experimental[id]);
  }
  await Promise.all(Object.entries(sources).map(([file, content]) => writeFile(path.join(providerDirectory, file), content)));

  await cp(path.join(ROOT, "templates", "cloudflare", "persistence.ts"), path.join(providerDirectory, "persistence.ts"));
  const entrypoint = replaceOnce(
    await readFile(path.join(ROOT, "templates", "cloudflare", "index.ts"), "utf8"),
    EXPERIMENTAL_CONFIG_LINE,
    // Baked in rather than passed as a Worker binding: `required` and friends decide how
    // strict the deployed OP is, and a binding can be edited or dropped after deployment.
    EXPERIMENTAL_CONFIG_LINE.replace("= {};", `= ${JSON.stringify(experimental)};`),
    "Cloudflare entrypoint template",
  );
  await writeFile(path.join(sourceDirectory, "index.ts"), entrypoint);
  await writeFile(path.join(appDirectory, "tsconfig.json"), `${JSON.stringify(GENERATED_TSCONFIG, null, 2)}\n`);

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
