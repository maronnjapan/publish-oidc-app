import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSX_OPTIONS, bundlePortal, portalClientPlugin } from "../../scripts/portal-build.mjs";

/**
 * Loading the TypeScript sources into a test.
 *
 * The Workers code is written for workerd and bundled by esbuild, so tests build it the same
 * way and import the result rather than reaching for a loader — what is tested is what is
 * deployed, JSX and virtual client bundle included.
 */

async function importBundle(code) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oidc-test-"));
  const outfile = path.join(directory, "module.mjs");
  await writeFile(outfile, code);
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

/** One module and everything it imports, built for Node. */
export async function importModule(entry) {
  const result = await build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    ...JSX_OPTIONS,
    // Only actually builds the client when something in the graph imports it.
    plugins: [portalClientPlugin({ minify: false })],
  });
  return importBundle(result.outputFiles[0].text);
}

/**
 * Several modules in one bundle, each under its own namespace.
 *
 * Building them separately would give each bundle its own copy of everything they share, so
 * a class from one would not be `instanceof` the same class from another. Anything a test
 * uses together has to be built together.
 */
export async function importModules(namespaces) {
  const contents = Object.entries(namespaces)
    .map(([name, entry]) => `export * as ${name} from ${JSON.stringify(path.resolve(entry))};`)
    .join("\n");
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    ...JSX_OPTIONS,
    // Only actually builds the client when something in the graph imports it.
    plugins: [portalClientPlugin({ minify: false })],
  });
  return importBundle(result.outputFiles[0].text);
}

/** The portal Worker exactly as `npm run build` produces it, minus the workerd conditions. */
export async function importPortal() {
  return importBundle(await bundlePortal({ platform: "node", conditions: [], minifyClient: false }));
}

let renderedDocument = null;

/** The server-rendered page, built once per test process. */
export async function portalHtml() {
  if (renderedDocument === null) {
    const { default: app } = await importPortal();
    renderedDocument = await (await app.request("https://portal.example/")).text();
  }
  return renderedDocument;
}
