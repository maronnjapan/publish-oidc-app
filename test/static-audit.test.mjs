import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SCHEMA_STATEMENTS } from "../scripts/setup.mjs";

test("one shared D1 schema namespaces all OIDC state by op_id", () => {
  const schema = SCHEMA_STATEMENTS.join("\n");
  for (const table of ["registry_ops", "oidc_users", "oidc_records", "oidc_consents", "oidc_consent_grants"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /PRIMARY KEY \(op_id, kind, record_key\)/);
  assert.match(schema, /registry_ops .*expires_at TEXT/);
  assert.match(schema, /registry_requests .*clone_token_hash TEXT/);
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

test("clone endpoint rebuilds repositories per request instead of storing code", async () => {
  const gitHttp = await readFile("system/portal/src/git-http.ts", "utf8");
  const repository = await readFile("system/portal/src/op-repo.ts", "utf8");
  assert.match(gitHttp, /buildOpRepository/);
  assert.match(gitHttp, /o\.status = 'active' AND \(o\.expires_at IS NULL OR o\.expires_at > \?2\)/);
  assert.match(gitHttp, /tokenMatches\(request, found\.cloneTokenHash\)/);
  assert.match(gitHttp, /www-authenticate/);
  assert.doesNotMatch(gitHttp, /INSERT INTO registry_ops|R2Bucket|KVNamespace|config_json/);
  assert.doesNotMatch(repository, /R2Bucket|KVNamespace/);
  assert.match(repository, /REPLACE_WITH_YOUR_CLIENT_SECRET/);
  const deploy = await readFile("scripts/deploy-portal.mjs", "utf8");
  assert.match(deploy, /buildOpCatalog/);
  assert.match(deploy, /RATE_LIMIT_CLONE_PER_IP_PER_DAY/);
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

test("guide covers secrets, shared D1, deployment, and smoke testing", async () => {
  const guide = await readFile("guide.sh", "utf8");
  assert.match(guide, /PORTAL_GITHUB_TOKEN/);
  assert.match(guide, /scripts\/setup\.mjs/);
  assert.match(guide, /npm run deploy:portal/);
  assert.match(guide, /npm run deploy:reaper/);
  assert.match(guide, /共有D1/);
  assert.match(guide, /Discovery/);
});
