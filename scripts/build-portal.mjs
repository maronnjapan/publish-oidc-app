#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib.mjs";
import { bundlePortal } from "./portal-build.mjs";

const outputDirectory = path.join(ROOT, "system", "portal", "dist");
await mkdir(outputDirectory, { recursive: true });
const code = await bundlePortal();
await writeFile(path.join(outputDirectory, "worker.js"), code);
process.stdout.write("system/portal/dist/worker.js\n");
