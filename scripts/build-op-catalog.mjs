#!/usr/bin/env node

/**
 * Bakes every feature-flag combination of the generated OP source into git objects that the
 * portal Worker can serve directly as a packfile.
 *
 * The generated `src/` tree depends only on the five feature toggles - the OP's identifiers all
 * live in Worker vars and secrets - so 32 variants cover every OP that will ever be published.
 * That is what makes `git clone` possible without keeping a copy of any OP's code in storage.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, importTsModule } from "./lib.mjs";
import { FEATURES, generateProviderSources, readCliPackage } from "./generate-op.mjs";
import { SCHEMA_STATEMENTS } from "./setup.mjs";

const CATALOG_VERSION = 1;
const CATALOG_PATH = path.join(ROOT, "system", "portal", "src", "op-catalog.generated.ts");
const DEFAULT_COMPATIBILITY_DATE = "2026-07-01";
const CONCURRENCY = 4;

export function featureMask(features) {
  return FEATURES.map((name) => (features[name] === false ? "0" : "1")).join("");
}

function maskToFeatures(mask) {
  return Object.fromEntries(FEATURES.map((name, index) => [name, mask[index] === "1"]));
}

function allMasks() {
  const masks = [];
  for (let value = 0; value < 1 << FEATURES.length; value += 1) {
    masks.push(FEATURES.map((_, index) => ((value >> index) & 1 ? "1" : "0")).join(""));
  }
  return masks;
}

async function collectTree(git, directory, objects, used) {
  const entries = await readdir(directory, { withFileTypes: true });
  const treeEntries = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      treeEntries.push({ name: entry.name, mode: git.TREE_MODE, oid: await collectTree(git, target, objects, used) });
      continue;
    }
    if (!entry.isFile()) throw new Error(`unexpected non-file entry in generated output: ${target}`);
    const { oid, object } = await git.makeObject(git.OBJECT_BLOB, new Uint8Array(await readFile(target)));
    objects.set(oid, object);
    used.add(oid);
    treeEntries.push({ name: entry.name, mode: git.FILE_MODE, oid });
  }
  const { oid, object } = await git.makeObject(git.OBJECT_TREE, git.encodeTree(treeEntries));
  objects.set(oid, object);
  used.add(oid);
  return oid;
}

async function addBlob(git, objects, text) {
  const { oid, object } = await git.makeObject(git.OBJECT_BLOB, new TextEncoder().encode(text));
  objects.set(oid, object);
  return oid;
}

async function inputsDigest(rootPackage, cliPackage, compatibilityDate) {
  const hash = createHash("sha256");
  hash.update(`v${CATALOG_VERSION}\n${cliPackage}\n${rootPackage.config.maronnOidcCore}\n${compatibilityDate}\n`);
  hash.update(JSON.stringify({ ...rootPackage.dependencies, ...rootPackage.devDependencies }));
  hash.update(SCHEMA_STATEMENTS.join(";\n"));
  for (const file of ["templates/cloudflare/index.ts", "templates/cloudflare/store.ts", "templates/cloudflare/resolvers.ts", "templates/cloudflare/persistence.ts", "scripts/generate-op.mjs", "scripts/build-op-catalog.mjs"]) {
    hash.update(await readFile(path.join(ROOT, file)));
  }
  return hash.digest("hex");
}

async function existingDigest() {
  try {
    const text = await readFile(CATALOG_PATH, "utf8");
    return /"digest":"([0-9a-f]{64})"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readCompatibilityDate() {
  try {
    const infra = JSON.parse(await readFile(path.join(ROOT, "infra.json"), "utf8"));
    return typeof infra.compatibility_date === "string" && infra.compatibility_date ? infra.compatibility_date : DEFAULT_COMPATIBILITY_DATE;
  } catch {
    return DEFAULT_COMPATIBILITY_DATE;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export async function buildOpCatalog({ force = false, log = () => {} } = {}) {
  const { rootPackage, cliPackage } = await readCliPackage();
  const compatibilityDate = await readCompatibilityDate();
  const digest = await inputsDigest(rootPackage, cliPackage, compatibilityDate);
  if (!force && (await existingDigest()) === digest) {
    log("op catalog is up to date");
    return { path: CATALOG_PATH, digest, rebuilt: false };
  }
  const git = await importTsModule(path.join(ROOT, "system", "portal", "src", "git.ts"));

  const workspace = await mkdtemp(path.join(os.tmpdir(), "maronn-op-catalog-"));
  const objects = new Map();
  const variants = {};
  try {
    const masks = allMasks();
    const generated = await mapWithConcurrency(masks, CONCURRENCY, async (mask) => {
      const sourceDirectory = path.join(workspace, mask, "src");
      await mkdir(sourceDirectory, { recursive: true });
      await generateProviderSources(maskToFeatures(mask), sourceDirectory);
      return { mask, sourceDirectory };
    });
    // Hashing happens serially so shared blobs land in a single deterministic object map.
    for (const { mask, sourceDirectory } of generated) {
      const used = new Set();
      const tree = await collectTree(git, sourceDirectory, objects, used);
      variants[mask] = [tree, [...used]];
      log(`variant ${mask} -> tree ${tree.slice(0, 12)} (${used.size} objects)`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  const staticFiles = {
    "tsconfig.json": await addBlob(git, objects, `${JSON.stringify(clonedTsconfig(), null, 2)}\n`),
    "schema.sql": await addBlob(git, objects, `${SCHEMA_STATEMENTS.join(";\n")};\n`),
  };

  const catalog = {
    version: CATALOG_VERSION,
    digest,
    generator: cliPackage,
    core: rootPackage.config.maronnOidcCore,
    compatibilityDate,
    dependencies: {
      "@maronn-oidc/core": rootPackage.dependencies["@maronn-oidc/core"],
      hono: rootPackage.dependencies.hono,
    },
    devDependencies: {
      "@cloudflare/workers-types": rootPackage.devDependencies["@cloudflare/workers-types"],
      typescript: rootPackage.devDependencies.typescript,
      wrangler: "^4.0.0",
    },
    staticFiles,
    objects: Object.fromEntries([...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([oid, object]) => [oid, [object.type, object.size, git.encodeBase64(object.deflated)]])),
    variants,
  };

  const json = JSON.stringify(catalog);
  // The payload is embedded in a String.raw template, so it must stay free of template syntax.
  if (/[`\\]|\$\{/.test(json)) throw new Error("catalog JSON contains characters that cannot be embedded in a raw template literal");
  await writeFile(
    CATALOG_PATH,
    [
      "// Generated by scripts/build-op-catalog.mjs. Do not edit by hand.",
      "// Every feature-flag variant of the generated OP source, stored as deflated git objects.",
      'import type { OpCatalog } from "./op-repo.js";',
      "",
      `export const OP_CATALOG = JSON.parse(String.raw\`${json}\`) as OpCatalog;`,
      "",
    ].join("\n"),
  );
  log(`wrote ${path.relative(ROOT, CATALOG_PATH)} (${objects.size} unique objects, ${Object.keys(variants).length} variants, ${(json.length / 1024).toFixed(0)} KiB)`);
  return { path: CATALOG_PATH, digest, rebuilt: true };
}

function clonedTsconfig() {
  return {
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
    include: ["src/**/*.ts"],
    exclude: ["node_modules"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildOpCatalog({ force: process.argv.includes("--force"), log: (message) => process.stdout.write(`${message}\n`) }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
