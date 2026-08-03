import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SCHEMA_STATEMENTS } from "../scripts/setup.mjs";

test("one shared D1 schema namespaces all OIDC state by op_id", () => {
  const schema = SCHEMA_STATEMENTS.join("\n");
  for (const table of ["registry_ops", "oidc_users", "oidc_records", "oidc_consents", "oidc_consent_grants"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /PRIMARY KEY \(op_id, kind, record_key\)/);
  assert.match(schema, /registry_ops .*expires_at TEXT/);
});

test("deployment binds the same D1 and uses op_id as script/subdomain name", async () => {
  const source = await readFile("scripts/deploy-op.mjs", "utf8");
  assert.match(source, /uploadWorker\(infra, token, opId/);
  assert.match(source, /type: "d1", name: "DB"/);
  assert.match(source, /OP_ID/);
  assert.match(source, /setWorkerSecret/);
  assert.match(source, /delete sanitizedConfig\.client_secret/);
  assert.match(source, /24 \* 60 \* 60 \* 1000/);
  assert.match(source, /expires_at/);
});

test("portal preserves reference IP/global limits and Origin verification", async () => {
  const portal = await readFile("system/portal/src/index.ts", "utf8");
  assert.match(portal, /RATE_LIMIT_PER_IP_PER_DAY/);
  assert.match(portal, /RATE_LIMIT_GLOBAL_PER_DAY/);
  assert.match(portal, /CF-Connecting-IP/);
  assert.match(portal, /origin !== `https:\/\/\$\{host\}`/);
});

test("GitHub workflow generates and deploys each OP independently", async () => {
  const workflow = await readFile(".github/workflows/generate-op.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /scripts\/deploy-op\.mjs/);
  assert.match(workflow, /oidc-op-\$\{\{ inputs\.op_id \}\}/);
});

test("system deployment installs the 24-hour reaper and its 15-minute cron", async () => {
  const workflow = await readFile(".github/workflows/deploy-system.yml", "utf8");
  const deploy = await readFile("scripts/deploy-reaper.mjs", "utf8");
  assert.match(workflow, /npm run deploy:reaper/);
  assert.match(deploy, /"maronn-oidc-reaper"/);
  assert.match(deploy, /\*\/15 \* \* \* \*/);
  assert.match(deploy, /ensureRegistryOpsExpiry/);
});

test("experimental features stay opt-in and are deployed as their own binding", async () => {
  const template = await readFile("templates/cloudflare/index.ts", "utf8");
  const deploy = await readFile("scripts/deploy-op.mjs", "utf8");
  const persistence = await readFile("templates/cloudflare/persistence.ts", "utf8");
  for (const marker of ["EXPERIMENTAL_IMPORT_PLACEHOLDER", "EXPERIMENTAL_RUNTIME_PLACEHOLDER", "EXPERIMENTAL_CONTEXT_PLACEHOLDER", "EXPERIMENTAL_ROUTE_PLACEHOLDER"]) {
    assert.match(template, new RegExp(marker));
  }
  assert.match(deploy, /name: "EXPERIMENTAL_FEATURES"/);
  // Type-only, so an OP without an experimental feature never bundles the package.
  assert.match(persistence, /import type \{[\s\S]*?\} from '@maronn-oidc\/experimental\/par';/);
  assert.match(persistence, /'par_request'/);
});

test("weekly package follow-up proposes updates and tracks unwired features", async () => {
  const workflow = await readFile(".github/workflows/check-package-updates.yml", "utf8");
  assert.match(workflow, /cron: "0 0 \* \* 1"/);
  assert.match(workflow, /check-package-updates\.mjs --apply/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /has_catalog_work == 'true'/);
});

test("guide covers secrets, shared D1, deployment, and smoke testing", async () => {
  const guide = await readFile("guide.sh", "utf8");
  assert.match(guide, /PORTAL_GITHUB_TOKEN/);
  assert.match(guide, /scripts\/setup\.mjs/);
  assert.match(guide, /npm run deploy:portal/);
  assert.match(guide, /npm run deploy:reaper/);
  assert.match(guide, /共有D1/);
  assert.match(guide, /Discovery/);
});
