import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { ROOT, bundle } from "./lib.mjs";

/**
 * Building the portal, both halves of it.
 *
 * The portal is uploaded as a single Worker module, so its browser bundle has to travel
 * inside it. The client is built first, hashed, and handed to the Worker build through the
 * `virtual:portal-client` module that `src/server/routes/assets.ts` serves from. Two builds
 * rather than one because the halves target different runtimes: the client is minified for
 * browsers, the Worker runs on workerd.
 *
 * Everything that needs a portal bundle — `npm run build`, the deploy script, the tests —
 * goes through here, so none of them can accidentally build it without its assets.
 */

export const VIRTUAL_CLIENT_MODULE = "virtual:portal-client";
export const PORTAL_ENTRY = path.join(ROOT, "system", "portal", "src", "index.ts");
export const CLIENT_ENTRY = path.join(ROOT, "system", "portal", "src", "client", "main.tsx");

/** Preact everywhere, including the server render, so one component tree serves both ends. */
export const JSX_OPTIONS = { jsx: "automatic", jsxImportSource: "preact" };

function contentHash(code) {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

function assetFor(file, extension, contentType) {
  const code = file.text;
  return { path: `/assets/app.${contentHash(code)}.${extension}`, code, contentType };
}

export async function buildPortalClient({ minify = true } = {}) {
  const result = await build({
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify,
    legalComments: "none",
    charset: "utf8",
    loader: { ".css": "css" },
    outdir: path.join(ROOT, "system", "portal", "dist", "client"),
    ...JSX_OPTIONS,
  });

  const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!js) throw new Error("the portal client build produced no JavaScript");
  if (!css) throw new Error("the portal client build produced no stylesheet");

  return {
    script: assetFor(js, "js", "text/javascript; charset=utf-8"),
    stylesheet: assetFor(css, "css", "text/css; charset=utf-8"),
  };
}

function moduleSource(assets) {
  return [
    `export const script = ${JSON.stringify(assets.script)};`,
    `export const stylesheet = ${JSON.stringify(assets.stylesheet)};`,
  ].join("\n");
}

/** Resolves `virtual:portal-client` for whichever build asks for it, building it once. */
export function portalClientPlugin(options = {}) {
  let pending = null;
  return {
    name: "portal-client",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^virtual:portal-client$/ }, () => ({
        path: VIRTUAL_CLIENT_MODULE,
        namespace: "portal-client",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "portal-client" }, async () => {
        pending ??= buildPortalClient(options);
        return { contents: moduleSource(await pending), loader: "js", resolveDir: ROOT };
      });
    },
  };
}

/**
 * The portal Worker module, client bundle included.
 *
 * `options` is passed through to esbuild, which is how the tests build the same entry for
 * Node instead of workerd.
 */
export function bundlePortal({ minifyClient = true, ...options } = {}) {
  return bundle(PORTAL_ENTRY, {
    ...JSX_OPTIONS,
    ...options,
    plugins: [portalClientPlugin({ minify: minifyClient }), ...(options.plugins ?? [])],
  });
}
