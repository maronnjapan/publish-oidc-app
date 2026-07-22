#!/usr/bin/env node

import path from "node:path";
import { ROOT, bundle, readInfra, requireEnv, setSubdomain, setWorkerSecret, uploadWorker, workerUrl } from "./lib.mjs";

const token = requireEnv("CLOUDFLARE_API_TOKEN");
const dispatchToken = requireEnv("GITHUB_DISPATCH_TOKEN");
const infra = await readInfra();
const scriptName = "maronn-oidc-portal";
const code = await bundle(path.join(ROOT, "system", "portal", "src", "index.ts"));
await uploadWorker(infra, token, scriptName, code, [
  { type: "d1", name: "DB", id: infra.d1_database_id },
  { type: "plain_text", name: "RATE_LIMIT_PER_IP_PER_DAY", text: process.env.RATE_LIMIT_PER_IP_PER_DAY || "10" },
  { type: "plain_text", name: "RATE_LIMIT_GLOBAL_PER_DAY", text: process.env.RATE_LIMIT_GLOBAL_PER_DAY || "50" },
  { type: "plain_text", name: "GITHUB_OWNER", text: infra.github_owner },
  { type: "plain_text", name: "GITHUB_REPO", text: infra.github_repo },
]);
await setWorkerSecret(infra, token, scriptName, "GITHUB_DISPATCH_TOKEN", dispatchToken);
await setSubdomain(infra, token, scriptName);
process.stdout.write(`${workerUrl(infra, scriptName)}\n`);
