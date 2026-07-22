#!/usr/bin/env node

import { REQUEST_ID_PATTERN, d1Query, readInfra, requireEnv } from "./lib.mjs";

const [requestId, status, errorCode] = process.argv.slice(2);
if (!REQUEST_ID_PATTERN.test(requestId ?? "") || !["generating", "failed"].includes(status)) {
  process.stderr.write("usage: node scripts/update-request.mjs <request_id> <generating|failed> [error_code]\n");
  process.exitCode = 1;
} else {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const infra = await readInfra();
  const now = new Date().toISOString();
  const error = status === "failed" ? (errorCode || "ci_failed").slice(0, 80) : null;
  if (status === "failed") {
    await d1Query(infra, token, `DELETE FROM oidc_users WHERE op_id = (SELECT op_id FROM registry_requests WHERE request_id = ?1)`, [requestId]);
  }
  await d1Query(infra, token, `UPDATE registry_requests SET status = ?2, error = ?3, config_json = CASE WHEN ?2 = 'failed' THEN NULL ELSE config_json END, updated_at = ?4 WHERE request_id = ?1`, [requestId, status, error, now]);
  process.stdout.write(`${status}\n`);
}
