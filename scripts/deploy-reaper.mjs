#!/usr/bin/env node

import path from "node:path";
import {
  ROOT,
  accountUrl,
  apiRequest,
  bundle,
  readInfra,
  requireEnv,
  setWorkerSecret,
  uploadWorker,
} from "./lib.mjs";
import { ensureRegistryOpsExpiry } from "./setup.mjs";

async function main() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const infra = await readInfra();
  const scriptName = "maronn-oidc-reaper";

  await ensureRegistryOpsExpiry(
    infra.account_id,
    token,
    infra.d1_database_id,
  );

  const code = await bundle(path.join(ROOT, "system", "reaper", "src", "index.ts"));
  await uploadWorker(infra, token, scriptName, code, [
    { type: "d1", name: "DB", id: infra.d1_database_id },
    { type: "plain_text", name: "ACCOUNT_ID", text: infra.account_id },
  ]);
  await setWorkerSecret(infra, token, scriptName, "CF_API_TOKEN", token);
  await apiRequest(
    accountUrl(infra, `/workers/scripts/${scriptName}/schedules`),
    token,
    { method: "PUT", body: JSON.stringify([{ cron: "*/15 * * * *" }]) },
  );
  process.stdout.write("deployed maronn-oidc-reaper with a 15-minute cron\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
