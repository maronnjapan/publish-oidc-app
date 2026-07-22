import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SCHEMA_STATEMENTS } from "../scripts/setup.mjs";

test("one shared D1 schema namespaces all OIDC state by op_id", () => {
  const schema = SCHEMA_STATEMENTS.join("\n");
  for (const table of ["registry_ops", "oidc_users", "oidc_records", "oidc_consents", "oidc_consent_grants"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /PRIMARY KEY \(op_id, kind, record_key\)/);
});

test("deployment binds the same D1 and uses op_id as script/subdomain name", async () => {
  const source = await readFile("scripts/deploy-op.mjs", "utf8");
  assert.match(source, /uploadWorker\(infra, token, opId/);
  assert.match(source, /type: "d1", name: "DB"/);
  assert.match(source, /OP_ID/);
  assert.match(source, /setWorkerSecret/);
  assert.match(source, /delete sanitizedConfig\.client_secret/);
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

test("guide covers secrets, shared D1, deployment, and smoke testing", async () => {
  const guide = await readFile("guide.sh", "utf8");
  assert.match(guide, /PORTAL_GITHUB_TOKEN/);
  assert.match(guide, /scripts\/setup\.mjs/);
  assert.match(guide, /npm run deploy:portal/);
  assert.match(guide, /共有D1/);
  assert.match(guide, /Discovery/);
});
