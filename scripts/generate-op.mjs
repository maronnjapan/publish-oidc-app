#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { OP_ID_PATTERN, ROOT, readExperimentalCatalog, readExtensionCatalog, readOptionalCatalog, supportedFeatures } from "./lib.mjs";

const execFile = promisify(execFileCallback);
const FEATURES = ["pkce", "refresh-token", "introspection", "revocation", "request-object", "form-post-response-mode", "implicit-flow", "hybrid-flow"];

/**
 * The scopes @maronn-openid-connect/core handles itself; anything else in config.scopes is
 * a custom scope the publisher declared (portal-choices.json's "scope" group only ever
 * offers these six, so the rest is by construction custom). Mirrors REQUIRED_SCOPE +
 * OPTIONAL_SCOPES in system/portal/src/shared/rules.ts and KNOWN_STANDARD_SCOPES in
 * scripts/check-package-updates.mjs; test/choices.test.mjs checks all three stay equal.
 */
const STANDARD_SCOPES = ["openid", "profile", "email", "address", "phone", "offline_access"];

function parseConfig(text, opId) {
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("OP config is not valid JSON"); }
  if (config.op_id !== opId) throw new Error("OP config op_id does not match");
  if (!config.features || FEATURES.some((name) => typeof config.features[name] !== "boolean")) throw new Error("OP feature configuration is invalid");
  if (!Array.isArray(config.scopes) || config.scopes[0] !== "openid") throw new Error("OP scope configuration is invalid");
  return config;
}

/**
 * Validates an opt-in selection against its catalog. Unknown ids and options are rejected
 * rather than ignored so a stale portal cannot silently produce an OP whose advertised
 * feature set is not actually generated. `kind` only names the group in error messages;
 * the optional and experimental catalogs share this shape on purpose.
 */
export function parseFeatureSelection(value, catalog, kind) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} selection must be an object`);
  const supported = new Map(supportedFeatures(catalog).map((feature) => [feature.id, feature]));
  const selection = {};
  for (const [id, rawOptions] of Object.entries(value)) {
    const feature = supported.get(id);
    if (!feature) throw new Error(`${kind} feature ${JSON.stringify(id)} is not supported`);
    if (rawOptions !== undefined && rawOptions !== null && (typeof rawOptions !== "object" || Array.isArray(rawOptions))) throw new Error(`${kind} feature ${JSON.stringify(id)} options must be an object`);
    const declared = new Map((feature.options ?? []).map((option) => [option.id, option]));
    const options = {};
    for (const [optionId, optionValue] of Object.entries(rawOptions ?? {})) {
      const declaredOption = declared.get(optionId);
      const where = JSON.stringify(`${id}.${optionId}`);
      if (!declaredOption) throw new Error(`${kind} option ${where} is not supported`);
      if (declaredOption.type === "text") {
        if (typeof optionValue !== "string") throw new Error(`${kind} option ${where} must be a string`);
        if (!new RegExp(declaredOption.pattern).test(optionValue)) throw new Error(`${kind} option ${where} does not look like a valid ${declaredOption.label}`);
      } else if (typeof optionValue !== "boolean") {
        throw new Error(`${kind} option ${where} must be true or false`);
      }
      options[optionId] = optionValue;
    }
    for (const [optionId, declaredOption] of declared) {
      if (optionId in options) continue;
      // A text option has no sensible default: leaving it out would generate a feature that
      // cannot work, so selecting the feature without it is refused rather than guessed.
      if (declaredOption.type === "text") throw new Error(`${kind} option ${JSON.stringify(`${id}.${optionId}`)} is required`);
      options[optionId] = declaredOption.default === true;
    }
    selection[id] = options;
  }
  return selection;
}

export function parseExperimentalSelection(value, catalog) {
  return parseFeatureSelection(value, catalog, "experimental");
}

export function parseOptionalSelection(value, catalog) {
  return parseFeatureSelection(value, catalog, "optional");
}

export function parseExtensionSelection(value, catalog) {
  return parseFeatureSelection(value, catalog, "extension");
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
      // entrypoint seeds into context win (templates/cloudflare/index.ts). A feature's context
      // hook runs inside the generated app and replaces what was set before it, so the
      // preference has to be written into the hook itself.
      sources["features/par/feature.ts"] = replaceOnce(
        sources["features/par/feature.ts"],
        "  context: { parStore },",
        "  context: ({ c }) => ({ parStore: c.get('parStore') ?? parStore }),",
        "generated features/par/feature.ts",
      );
      // /authorize enforces the publisher's scope selection too, but a client that pushes
      // an unavailable scope should learn about it at push time rather than one redirect
      // later (RFC 9126 §2.1 validates as the authorization endpoint would).
      sources["features/par/endpoints/par/steps/validate-request.ts"] = replaceOnce(
        sources["features/par/endpoints/par/steps/validate-request.ts"],
        "import { validatePushedAuthorizationParams } from",
        "import { ParError, validatePushedAuthorizationParams } from",
        "generated par validate-request.ts",
      );
      sources["features/par/endpoints/par/steps/validate-request.ts"] = replaceOnce(
        sources["features/par/endpoints/par/steps/validate-request.ts"],
        "  await validatePushedAuthorizationParams(pushedParams, clientResolver, {",
        "  // Enforce the scopes selected in the publisher UI.\n  const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n  const unsupportedScopes = (pushedParams['scope'] ?? '').split(' ').filter((scope) => scope.length > 0 && !allowedScopes.includes(scope));\n  if (unsupportedScopes.length > 0) {\n    throw new ParError('invalid_scope', 'Unsupported scope: ' + unsupportedScopes.join(' '));\n  }\n\n  await validatePushedAuthorizationParams(pushedParams, clientResolver, {",
        "generated par validate-request.ts",
      );
      if (options.required) {
        sources["features/par/config.ts"] = replaceOnce(
          sources["features/par/config.ts"],
          "  requirePushedAuthorizationRequests: false,",
          "  requirePushedAuthorizationRequests: true,",
          "generated features/par/config.ts",
        );
      }
    },
  },
  "token-exchange": {
    // RFC 8693 is generated whole by the CLI. allowedTargets stays empty (fail safe):
    // scope-narrowing and lifetime-shortening exchanges work, naming a target does not.
    apply() {},
  },
  jarm: {
    // JARM is generated whole by the CLI (features/jarm/ and the response-mode hooks of
    // /authorize and /consent). The scope enforcement patch below throws the same
    // AuthorizationError the CLI's own checks do, so the CLI turns it into the signed
    // response itself and nothing here needs to know about JARM.
    apply() {},
  },
  "device-authorization-grant": {
    apply(sources) {
      // The generated device authorization store is in-memory. Let the D1-backed one that
      // the Worker entrypoint seeds into context win (templates/cloudflare/index.ts), same
      // as the PAR store above.
      sources["features/device-authorization-grant/feature.ts"] = replaceOnce(
        sources["features/device-authorization-grant/feature.ts"],
        "  context: { deviceAuthorizationStore },",
        "  context: ({ c }) => ({ deviceAuthorizationStore: c.get('deviceAuthorizationStore') ?? deviceAuthorizationStore }),",
        "generated features/device-authorization-grant/feature.ts",
      );
      // /device_authorization never goes through /authorize, so it has to enforce the
      // publisher's scope selection on its own — a client that asks for an unavailable
      // scope should learn about it at request time, same rationale as PAR above.
      // The step function has no context, so the check goes right after it in the handler;
      // the scope it returns has already had offline_access policy applied.
      const devicePipeline = "features/device-authorization-grant/endpoints/device-authorization/pipeline.ts";
      sources[devicePipeline] = replaceOnce(
        sources[devicePipeline],
        "import { Hono } from 'hono';\n",
        "import { Hono } from 'hono';\nimport { DeviceAuthorizationError } from '@maronn-openid-connect/experimental/device-authorization-grant';\n",
        "generated device-authorization pipeline.ts",
      );
      sources[devicePipeline] = replaceOnce(
        sources[devicePipeline],
        "    const scope = validateDeviceAuthorizationRequest(params, client);",
        "    const scope = validateDeviceAuthorizationRequest(params, client);\n\n    // Enforce the scopes selected in the publisher UI.\n    const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n    const unsupportedScopes = scope.filter((value) => !allowedScopes.includes(value));\n    if (unsupportedScopes.length > 0) {\n      throw new DeviceAuthorizationError('invalid_scope', 'Unsupported scope: ' + unsupportedScopes.join(' '));\n    }",
        "generated device-authorization pipeline.ts",
      );
    },
  },
  // ID-JAG (Cross-App Access) is generated whole by the CLI (features/id-jag/ and the token endpoint's grant hooks).
  // Both allowedAudiences (issuance) and trustedIdentityProviders (redemption) stay empty
  // (fail safe): every request is rejected until the generated OP's idJagConfig is hand-edited,
  // same rationale as token-exchange's allowedTargets. The portal only has to register the
  // token-exchange and jwt-bearer grants on the client, which clientGrantTypes() in
  // scripts/deploy-op.mjs does.
  "id-jag": {
    apply() {},
  },
  ciba: {
    apply(sources) {
      // The generated CIBA stores are in-memory. Let the D1-backed ones that the Worker
      // entrypoint seeds into context win (templates/cloudflare/index.ts), same as PAR
      // and the device authorization grant above.
      sources["features/ciba/feature.ts"] = replaceOnce(
        sources["features/ciba/feature.ts"],
        "    cibaAuthenticationRequestStore,\n    cibaLoginTransactionStore,",
        "    cibaAuthenticationRequestStore: c.get('cibaAuthenticationRequestStore') ?? cibaAuthenticationRequestStore,\n    cibaLoginTransactionStore: c.get('cibaLoginTransactionStore') ?? cibaLoginTransactionStore,",
        "generated features/ciba/feature.ts",
      );
      // /backchannel_authentication never goes through /authorize, so it has to enforce
      // the publisher's scope selection on its own — a client that asks for an
      // unavailable scope should learn about it when it POSTs, not after the user
      // approves it on the authentication device UI. Mirrors PAR and device
      // authorization above.
      const cibaPipeline = "features/ciba/endpoints/backchannel-authentication/pipeline.ts";
      sources[cibaPipeline] = replaceOnce(
        sources[cibaPipeline],
        "import { Hono } from 'hono';\n",
        "import { Hono } from 'hono';\nimport { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';\n",
        "generated backchannel-authentication pipeline.ts",
      );
      sources[cibaPipeline] = replaceOnce(
        sources[cibaPipeline],
        "    validateCibaClientScope(params, client);",
        "    validateCibaClientScope(params, client);\n\n    // Enforce the scopes selected in the publisher UI.\n    const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n    const unsupportedScopes = (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0 && !allowedScopes.includes(scope));\n    if (unsupportedScopes.length > 0) {\n      throw new BackchannelAuthenticationError('invalid_scope', 'Unsupported scope: ' + unsupportedScopes.join(' '));\n    }",
        "generated backchannel-authentication pipeline.ts",
      );
    },
  },
  // RFC 9701 (JWT Response for OAuth Token Introspection) is generated whole by the CLI:
  // the alternate JWT response, its Accept-header negotiation (RFC 9701 §4/§8.2) and its
  // Discovery metadata all live in features/jwt-introspection-response/ with no
  // repository-owned knob to patch.
  "jwt-introspection-response": {
    apply() {},
  },
  // RP-Initiated Logout 1.0 is generated whole by the CLI (features/rp-initiated-logout/,
  // end_session_endpoint in Discovery). It needs no new
  // persistence: the confirmation travels in an HttpOnly cookie and the session it ends is the
  // browser-session record the D1 store already holds. rpInitiatedLogoutConfig's
  // postLogoutRedirectUris stays empty (fail safe): a logout always ends on the OP's own
  // "Logged out" page and never redirects, until the generated OP is hand-edited.
  "rp-initiated-logout": {
    apply() {},
  },
  // RFC 7591 is generated whole by the CLI (routes/register.ts, the store contract and
  // resolver wrapper in store.ts, registration_endpoint in Discovery). The generated store
  // is in-memory, which on Workers would forget every registration on the next isolate, so
  // the D1-backed one seeded into context wins (templates/cloudflare/index.ts). The resolver
  // wrapper reads the module-level store rather than the context one, so it is given the
  // per-request store explicitly. initialAccessToken stays unset (open registration, the
  // CLI default); the per-OP maxRegisteredClients cap (100) bounds what one OP can store.
  "dynamic-client-registration": {
    apply(sources) {
      sources["features/dynamic-client-registration/store.ts"] = replaceOnce(
        sources["features/dynamic-client-registration/store.ts"],
        "  Resolver extends { findClient(clientId: string): Promise<any> },\n>(base: Resolver): Resolver {",
        "  Resolver extends { findClient(clientId: string): Promise<any> },\n>(base: Resolver, store: DynamicallyRegisteredClientStore = dynamicClientStore): Resolver {",
        "generated dynamic-client-registration store.ts",
      );
      sources["features/dynamic-client-registration/store.ts"] = replaceOnce(
        sources["features/dynamic-client-registration/store.ts"],
        "      return (await dynamicClientStore.get(clientId)) ?? null;",
        "      return (await store.get(clientId)) ?? null;",
        "generated dynamic-client-registration store.ts",
      );
      const feature = "features/dynamic-client-registration/feature.ts";
      sources[feature] = replaceOnce(
        sources[feature],
        "  context: ({ c, options }) => ({\n    dynamicClientStore,",
        "  context: ({ c, options }) => ({\n    dynamicClientStore: c.get('dynamicClientStore') ?? dynamicClientStore,",
        "generated dynamic-client-registration feature.ts",
      );
      sources[feature] = replaceOnce(
        sources[feature],
        "withDynamicallyRegisteredClients(c.get('clientResolver'))",
        "withDynamicallyRegisteredClients(c.get('clientResolver'), c.get('dynamicClientStore') ?? dynamicClientStore)",
        "generated dynamic-client-registration feature.ts",
      );
      sources[feature] = replaceOnce(
        sources[feature],
        "withDynamicallyRegisteredClients(c.get('tokenClientResolver'))",
        "withDynamicallyRegisteredClients(c.get('tokenClientResolver'), c.get('dynamicClientStore') ?? dynamicClientStore)",
        "generated dynamic-client-registration feature.ts",
      );
    },
  },
};

/**
 * Same contract as EXPERIMENTAL_WIRING, for the CLI's own opt-in features. These are
 * stable hardening the CLI generates itself, so an entry with an empty apply() is the
 * normal case; it exists so that offering a feature in the portal and knowing how to
 * generate it stay one decision (see docs/optional-features.md).
 */
export const OPTIONAL_WIRING = {
  // Empty on purpose: cli 0.11.0 promoted its only optional feature (transaction-binding)
  // to default behavior, so nothing is selectable right now. The table and the catalog stay
  // so that the next optional feature is data plus one entry here.
};

/**
 * Same contract again for the CLI's "Extension features": opt-in integrations that each
 * need a package of their own (docs/extension-features.md). Besides `apply()` over the
 * generated sources, an entry may carry:
 *   files       generated-file name -> template path copied into the provider directory
 *   entrypoint  (source, options) => source, the Worker entrypoint's own wiring (the
 *               extension needs runtime configuration that only the entrypoint can supply)
 */
export const EXTENSION_WIRING = {
  // "Sign in with Google". The CLI generates the button, POST /login/google and the nonce
  // store (the JSON-backed one rides on the shared D1 like every other store). What this
  // repository supplies: the Google OAuth client ID the publisher typed in, a verifier that
  // loads on Workers (google-auth-library does not; see google-id-token-verifier.ts), and
  // D1 persistence for the users it provisions (linkFederatedIdentity in persistence.ts).
  "google-login": {
    files: { "google-id-token-verifier.ts": "templates/cloudflare/google-id-token-verifier.ts" },
    apply() {},
    entrypoint(source, options) {
      const googleLogin = { clientId: options.clientId, requireVerifiedEmail: options.requireVerifiedEmail === true };
      let patched = replaceOnce(
        source,
        "import { applyOidc } from './oidc-provider/apply.js';",
        "import { applyOidc } from './oidc-provider/apply.js';\nimport { createWorkersGoogleIdTokenVerifier } from './oidc-provider/google-id-token-verifier.js';",
        "Cloudflare entrypoint template",
      );
      patched = replaceOnce(
        patched,
        "    config: { issuer: env.OP_ISSUER },",
        `    config: { issuer: env.OP_ISSUER, googleLogin: ${JSON.stringify(googleLogin)} },\n    googleIdTokenVerifier: createWorkersGoogleIdTokenVerifier(),`,
        "Cloudflare entrypoint template",
      );
      return patched;
    },
  },
};

const EXPERIMENTAL_CONFIG_LINE = "const EXPERIMENTAL_FEATURES: Record<string, Record<string, unknown>> = {};";
const OPTIONAL_CONFIG_LINE = "const OPTIONAL_FEATURES: Record<string, Record<string, unknown>> = {};";
const EXTENSION_CONFIG_LINE = "const EXTENSION_FEATURES: Record<string, Record<string, unknown>> = {};";

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
  // cli 0.15 lays each endpoint out as endpoints/<name>/steps/*.ts, one exported function per
  // step. The publisher's scope selection is enforced inside validateAuthorizationRequestParams()
  // by throwing the same AuthorizationError its own scope checks throw.
  // authorizationErrorOutcome() then turns it into the redirectable error, including the signed
  // JARM response when --enable jarm is on, so this patch does not need to know about JARM.
  //
  // Named disallowedScopes rather than unsupportedScopes: with --scope declared (see
  // STANDARD_SCOPES above) the generated code already declares that name in this scope.
  sources["endpoints/authorize/steps/validate-request.ts"] = replaceOnce(
    sources["endpoints/authorize/steps/validate-request.ts"],
    "  validateClientScope(scope, client.scope, redirectUri, state);\n",
    "  validateClientScope(scope, client.scope, redirectUri, state);\n\n  // Enforce the scopes selected in the publisher UI.\n  const allowedScopes = (c.get('allowedScopes') as string[] | undefined) ?? ['openid'];\n  const disallowedScopes = scope.filter((value) => !allowedScopes.includes(value));\n  if (disallowedScopes.length > 0) {\n    throw new AuthorizationError(AuthorizationErrorCode.InvalidScope, 'Unsupported scope: ' + disallowedScopes.join(' '), redirectUri, state);\n  }\n",
    "generated authorize validate-request.ts",
  );

  // The publisher's selection, not the CLI's static list, decides what this OP advertises.
  // The refresh-token feature merges offline_access into scopes_supported on its own, which
  // would advertise a scope the OP rejects when the publisher did not select it, so the
  // finished metadata gets the selection back.
  sources["endpoints/discovery/steps/build-metadata.ts"] = replaceOnce(
    sources["endpoints/discovery/steps/build-metadata.ts"],
    "  return discoveryOf(\n    features,\n    { ...metadata, code_challenge_methods_supported: ['S256'] },\n    issuer,\n    config,\n  );",
    "  const advertised = discoveryOf(\n    features,\n    { ...metadata, code_challenge_methods_supported: ['S256'] },\n    issuer,\n    config,\n  );\n  return { ...advertised, scopes_supported: (c.get('allowedScopes') as string[] | undefined) ?? ['openid'] };",
    "generated discovery build-metadata.ts",
  );
  // The CLI's development accounts (testuser / otheruser) live in development.ts and reach a
  // provider only when something registers them explicitly; the generated app never does,
  // and accounts here come from the shared D1 only (test/generator.test.mjs checks the login).
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
    // The CLI's pages and views are .tsx files marked `@jsxImportSource hono/jsx`; esbuild
    // only honours that pragma when the automatic runtime is selected, otherwise it
    // emits React.createElement and every page fails with "React is not defined".
    jsx: "react-jsx",
    jsxImportSource: "hono/jsx",
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
  const optional = parseOptionalSelection(config.optional, await readOptionalCatalog());
  const optionalIds = Object.keys(optional);
  const extension = parseExtensionSelection(config.extension, await readExtensionCatalog());
  const extensionIds = Object.keys(extension);

  const disabled = FEATURES.filter((name) => config.features[name] === false);
  // Anything in config.scopes beyond the six standard scopes is a custom scope the
  // publisher declared (see docs/custom-scopes.md); the CLI needs to know about it at
  // generation time so it can advertise it and reject requests for anything else.
  const customScopeIds = config.scopes.filter((scope) => !STANDARD_SCOPES.includes(scope));
  const args = ["exec", "--yes", `--package=${cliPackage}`, "--", "maronn-oidc", "generate", "hono", "--db", "kv", "--output", providerDirectory];
  if (disabled.length > 0) args.push("--disable", disabled.join(","));
  if (customScopeIds.length > 0) args.push("--scope", customScopeIds.join(","));
  // All opt-in groups share one --enable list: the CLI namespaces its feature ids across
  // the groups, so the selection is what decides which is which.
  const enabledIds = [...optionalIds, ...experimentalIds, ...extensionIds];
  if (enabledIds.length > 0) args.push("--enable", enabledIds.join(","));
  await execFile("npm", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });

  const patched = [
    "endpoints/authorize/steps/validate-request.ts",
    "endpoints/discovery/steps/build-metadata.ts",
    ...(experimentalIds.includes("par") ? ["features/par/feature.ts", "features/par/config.ts", "features/par/endpoints/par/steps/validate-request.ts"] : []),
    ...(experimentalIds.includes("device-authorization-grant") ? ["features/device-authorization-grant/feature.ts", "features/device-authorization-grant/endpoints/device-authorization/pipeline.ts"] : []),
    ...(experimentalIds.includes("ciba") ? ["features/ciba/feature.ts", "features/ciba/endpoints/backchannel-authentication/pipeline.ts"] : []),
    ...(experimentalIds.includes("dynamic-client-registration") ? ["features/dynamic-client-registration/feature.ts", "features/dynamic-client-registration/store.ts"] : []),
  ];
  const sources = Object.fromEntries(await Promise.all(
    patched.map(async (file) => [file, await readFile(path.join(providerDirectory, file), "utf8")]),
  ));
  patchGeneratedSource(sources);
  for (const [ids, selection, wiringTable, kind, guide] of [
    [optionalIds, optional, OPTIONAL_WIRING, "optional", "docs/optional-features.md"],
    [experimentalIds, experimental, EXPERIMENTAL_WIRING, "experimental", "docs/experimental.md"],
    [extensionIds, extension, EXTENSION_WIRING, "extension", "docs/extension-features.md"],
  ]) {
    for (const id of ids) {
      const wiring = wiringTable[id];
      if (!wiring) throw new Error(`${kind} feature ${JSON.stringify(id)} has no generator wiring; see ${guide}`);
      wiring.apply(sources, selection[id]);
    }
  }
  // Extension features may ship files of their own next to the generated sources.
  for (const id of extensionIds) {
    for (const [name, template] of Object.entries(EXTENSION_WIRING[id].files ?? {})) {
      sources[name] = await readFile(path.join(ROOT, template), "utf8");
    }
  }
  await Promise.all(Object.entries(sources).map(([file, content]) => writeFile(path.join(providerDirectory, file), content)));

  await cp(path.join(ROOT, "templates", "cloudflare", "persistence.ts"), path.join(providerDirectory, "persistence.ts"));
  // --db kv leaves db/instance.ts to the project: it is the one place the store is chosen.
  await cp(path.join(ROOT, "templates", "cloudflare", "db-instance.ts"), path.join(providerDirectory, "db", "instance.ts"));
  // Baked in rather than passed as Worker bindings: options like PAR's `required` decide
  // how strict the deployed OP is, and a binding can be edited or dropped after deployment.
  let entrypoint = await readFile(path.join(ROOT, "templates", "cloudflare", "index.ts"), "utf8");
  for (const [line, selection] of [[OPTIONAL_CONFIG_LINE, optional], [EXPERIMENTAL_CONFIG_LINE, experimental], [EXTENSION_CONFIG_LINE, extension]]) {
    entrypoint = replaceOnce(entrypoint, line, line.replace("= {};", `= ${JSON.stringify(selection)};`), "Cloudflare entrypoint template");
  }
  for (const id of extensionIds) {
    entrypoint = EXTENSION_WIRING[id].entrypoint?.(entrypoint, extension[id]) ?? entrypoint;
  }
  await writeFile(path.join(sourceDirectory, "index.ts"), entrypoint);
  // Files an extension ships next to the provider are held to the same contract.
  const extensionSources = extensionIds.flatMap((id) => Object.keys(EXTENSION_WIRING[id].files ?? {})).filter((name) => name.endsWith(".ts")).map((name) => `src/oidc-provider/${name}`);
  await writeFile(path.join(appDirectory, "tsconfig.json"), `${JSON.stringify({ ...GENERATED_TSCONFIG, include: [...GENERATED_TSCONFIG.include, ...extensionSources] }, null, 2)}\n`);

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
    optional,
    experimental,
    extension,
    ...(experimentalIds.length > 0 ? { experimental_package: rootPackage.config.maronnOidcExperimental } : {}),
    generated_at: new Date().toISOString(),
  };
  await writeFile(path.join(appDirectory, "op.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { appDirectory, entryPoint: path.join(sourceDirectory, "index.ts"), config, cliPackage, experimental, optional, extension };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [opId, configPath] = process.argv.slice(2);
  if (!opId || !configPath) throw new Error("usage: node scripts/generate-op.mjs <op_id> <config.json>");
  generateOp(opId, path.resolve(configPath)).then(({ appDirectory }) => process.stdout.write(`${appDirectory}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
