#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { OP_ID_PATTERN, ROOT } from "./lib.mjs";

const execFile = promisify(execFileCallback);
export const FEATURES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"];

function parseConfig(text, opId) {
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("OP config is not valid JSON"); }
  if (config.op_id !== opId) throw new Error("OP config op_id does not match");
  if (!config.features || FEATURES.some((name) => typeof config.features[name] !== "boolean")) throw new Error("OP feature configuration is invalid");
  if (!Array.isArray(config.scopes) || config.scopes[0] !== "openid") throw new Error("OP scope configuration is invalid");
  return config;
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

export async function readCliPackage() {
  const rootPackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const cliPackage = rootPackage.config?.maronnOidcCli;
  if (typeof cliPackage !== "string" || !/^@maronn-oidc\/cli@\d+\.\d+\.\d+$/.test(cliPackage)) throw new Error("package.json config.maronnOidcCli must be an exact package version");
  return { rootPackage, cliPackage };
}

/**
 * Writes the complete `src/` tree for one feature selection. The output depends only on the
 * feature flags, which is what lets the portal serve `git clone` from a build-time catalog
 * instead of storing a copy of every generated OP.
 */
export async function generateProviderSources(features, sourceDirectory) {
  const providerDirectory = path.join(sourceDirectory, "oidc-provider");
  await mkdir(providerDirectory, { recursive: true });
  const { cliPackage } = await readCliPackage();
  const disabled = FEATURES.filter((name) => features[name] === false);
  const args = ["exec", "--yes", `--package=${cliPackage}`, "--", "maronn-oidc", "generate", "hono", "--output", providerDirectory];
  if (disabled.length > 0) args.push("--disable", disabled.join(","));
  await execFile("npm", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });

  await cp(path.join(ROOT, "templates", "cloudflare", "store.ts"), path.join(providerDirectory, "store.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "resolvers.ts"), path.join(providerDirectory, "resolvers.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "persistence.ts"), path.join(providerDirectory, "persistence.ts"));
  await cp(path.join(ROOT, "templates", "cloudflare", "index.ts"), path.join(sourceDirectory, "index.ts"));
  await patchGeneratedSource(providerDirectory);
  return { cliPackage, providerDirectory };
}

export async function generateOp(opId, configPath) {
  if (!OP_ID_PATTERN.test(opId)) throw new Error("invalid op_id");
  const config = parseConfig(await readFile(configPath, "utf8"), opId);
  const appDirectory = path.join(ROOT, "apps", opId);
  const sourceDirectory = path.join(appDirectory, "src");
  const { rootPackage } = await readCliPackage();
  const { cliPackage } = await generateProviderSources(config.features, sourceDirectory);

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
    generated_at: new Date().toISOString(),
  };
  await writeFile(path.join(appDirectory, "op.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { appDirectory, entryPoint: path.join(sourceDirectory, "index.ts"), config, cliPackage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [opId, configPath] = process.argv.slice(2);
  if (!opId || !configPath) throw new Error("usage: node scripts/generate-op.mjs <op_id> <config.json>");
  generateOp(opId, path.resolve(configPath)).then(({ appDirectory }) => process.stdout.write(`${appDirectory}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
