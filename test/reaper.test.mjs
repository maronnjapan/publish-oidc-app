import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "oidc-reaper-test-"));
const output = path.join(temporaryDirectory, "reaper.mjs");
await build({
  entryPoints: [path.resolve("system/reaper/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: output,
});
const { runMaintenance } = await import(`${pathToFileURL(output).href}?${Date.now()}`);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function createDatabase({ expired = [], stale = [], events = [] } = {}) {
  let activeExpired = expired;
  let activeStale = stale;
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              if (sql.includes("FROM registry_ops")) return { results: activeExpired };
              if (sql.includes("FROM registry_requests r")) return { results: activeStale };
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("DELETE FROM registry_rate_limits")) {
                events.push("rate-limits");
              } else {
                const table = sql.match(/^DELETE FROM ([a-z_]+)/)?.[1];
                if (table) events.push(table);
                if (table === "registry_ops") activeExpired = [];
                if (table === "registry_requests") activeStale = [];
              }
              return { success: true, params };
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

test("an expired UI-deployed OP Worker and all op_id-scoped D1 data are deleted", async () => {
  const events = [];
  const DB = createDatabase({
    expired: [{ op_id: "maronn-op-abc123defg", script_name: "maronn-op-abc123defg" }],
    events,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method, "DELETE");
    assert.match(String(url), /workers\/scripts\/maronn-op-abc123defg\?force=true$/);
    events.push("worker");
    return new Response(null, { status: 204 });
  };
  try {
    await runMaintenance(
      { DB, CF_API_TOKEN: "token", ACCOUNT_ID: "account" },
      new Date("2026-07-23T12:00:00Z"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(events.slice(0, 7), [
    "worker",
    "oidc_consent_grants",
    "oidc_consents",
    "oidc_records",
    "oidc_users",
    "registry_requests",
    "registry_ops",
  ]);
});

test("a stale UI request recovers an orphan Worker even without a registry_ops row", async () => {
  const events = [];
  const DB = createDatabase({
    stale: [{ op_id: "maronn-op-orphan1234", script_name: "maronn-op-orphan1234" }],
    events,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    events.push("worker-absent");
    return new Response(null, { status: 404 });
  };
  try {
    await runMaintenance(
      { DB, CF_API_TOKEN: "token", ACCOUNT_ID: "account" },
      new Date("2026-07-23T12:00:00Z"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(events[0], "worker-absent");
  assert.equal(events.includes("oidc_users"), true);
  assert.equal(events.includes("registry_requests"), true);
});

test("a failed Worker deletion leaves D1 data for the next cron retry", async () => {
  const events = [];
  const target = { op_id: "maronn-op-retry12345", script_name: "maronn-op-retry12345" };
  const DB = createDatabase({ expired: [target], events });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(null, { status: attempts === 1 ? 503 : 204 });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const env = { DB, CF_API_TOKEN: "token", ACCOUNT_ID: "account" };
    await runMaintenance(env, new Date("2026-07-23T12:00:00Z"));
    assert.equal(events.includes("registry_ops"), false);
    await runMaintenance(env, new Date("2026-07-23T12:15:00Z"));
    assert.equal(events.includes("registry_ops"), true);
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts, 2);
});

test("the reaper refuses to delete a system Worker even if a registry row is malformed", async () => {
  const events = [];
  const DB = createDatabase({
    expired: [{ op_id: "maronn-op-abc123defg", script_name: "maronn-oidc-portal" }],
    events,
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(null, { status: 204 });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await runMaintenance(
      { DB, CF_API_TOKEN: "token", ACCOUNT_ID: "account" },
      new Date("2026-07-23T12:00:00Z"),
    );
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(events.includes("registry_ops"), false);
});
