#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, bundle } from "./lib.mjs";
import { buildOpCatalog } from "./build-op-catalog.mjs";

const outputDirectory = path.join(ROOT, "system", "portal", "dist");
await mkdir(outputDirectory, { recursive: true });
await buildOpCatalog({ log: (message) => process.stdout.write(`${message}\n`) });
const code = await bundle(path.join(ROOT, "system", "portal", "src", "index.ts"));
await writeFile(path.join(outputDirectory, "worker.js"), code);
process.stdout.write("system/portal/dist/worker.js\n");
