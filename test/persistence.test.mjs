import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-persistence-test-"));
const output = path.join(temporary, "persistence.mjs");
await build({ entryPoints: [path.resolve("templates/cloudflare/persistence.ts")], bundle: true, platform: "node", format: "esm", outfile: output });
const { createD1Runtime } = await import(`${pathToFileURL(output).href}?${Date.now()}`);

class RecordDatabase {
  records = new Map();

  prepare(sql) {
    const database = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes("FROM oidc_records")) return database.records.get(`${params[0]}|${params[1]}|${params[2]}`) ?? null;
            return null;
          },
          async run() {
            if (sql.startsWith("INSERT INTO oidc_records")) {
              database.records.set(`${params[0]}|${params[1]}|${params[2]}`, { value_json: params[3], expires_at: params[4], updated_at: params[5] });
            } else if (sql.includes("json_extract(value_json, '$.grantId')")) {
              for (const [key, value] of database.records) {
                const [opId, kind] = key.split("|");
                if (opId === params[0] && kind === params[1] && JSON.parse(value.value_json).grantId === params[2]) database.records.delete(key);
              }
            } else if (sql.startsWith("DELETE FROM oidc_records")) {
              database.records.delete(`${params[0]}|${params[1]}|${params[2]}`);
            }
            return { success: true };
          },
          async all() { return { success: true, results: [] }; },
        };
      },
    };
  }

  async batch(statements) { for (const statement of statements) await statement.run(); return []; }
}

const client = { clientId: "client_test", redirectUris: ["https://client.example/callback"], clientType: "public", tokenEndpointAuthMethod: "none" };

test("D1 runtime persists records and isolates the same key by Worker subdomain op_id", async () => {
  const DB = new RecordDatabase();
  const first = createD1Runtime(DB, "maronn-op-first00000", client);
  const second = createD1Runtime(DB, "maronn-op-second0000", client);
  const transaction = { clientId: "client_test", redirectUri: "https://client.example/callback", responseType: "code", scope: "openid", csrfToken: "csrf" };
  await first.transactionStore.put("auth_txn:shared", transaction, 600);
  assert.deepEqual(await first.transactionStore.get("auth_txn:shared"), transaction);
  assert.equal(await second.transactionStore.get("auth_txn:shared"), null);
  assert.equal([...DB.records.keys()].some((key) => key.includes("auth_txn:shared")), false, "opaque record keys must not expose bearer values");
});

test("authorization code consumption remains persisted for replay detection", async () => {
  const DB = new RecordDatabase();
  const runtime = createD1Runtime(DB, "maronn-op-replay00000", client);
  const info = { clientId: "client_test", redirectUri: "https://client.example/callback", scope: ["openid"], codeChallenge: "challenge", codeChallengeMethod: "S256", expiresAt: Math.floor(Date.now() / 1000) + 300, used: false, grantId: "grant-1" };
  await runtime.authCodeStore.set("authorization-code", info);
  await runtime.authorizationCodeResolver.revokeAuthorizationCode("authorization-code");
  assert.equal((await runtime.authCodeStore.get("authorization-code")).used, true);
});

test("grant revocation deletes access and refresh token families from shared D1", async () => {
  const DB = new RecordDatabase();
  const runtime = createD1Runtime(DB, "maronn-op-grant000000", client);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await runtime.accessTokenStore.set("access", { sub: "alice", clientId: "client_test", scope: ["openid"], expiresAt, grantId: "grant-1" });
  await runtime.refreshTokenStore.set("refresh", { subject: "alice", clientId: "client_test", scope: ["openid"], expiresAt, originalIssuedAt: Math.floor(Date.now() / 1000), used: false, grantId: "grant-1", authTime: Math.floor(Date.now() / 1000) });
  await runtime.authorizationCodeResolver.revokeTokensByGrantId("grant-1");
  assert.equal(await runtime.accessTokenStore.get("access"), undefined);
  assert.equal(await runtime.refreshTokenStore.get("refresh"), undefined);
});
