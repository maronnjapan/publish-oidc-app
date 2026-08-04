import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { generateOp } from "../scripts/generate-op.mjs";
import { MemoryD1 } from "./support/d1-mock.mjs";

// The overlay implements the store contract the CLI generates, so it is bundled from a
// generated app rather than from templates/ (where ./store.js does not exist yet).
const opId = "maronn-op-store1234567";
const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-persistence-test-"));
const configPath = path.join(temporary, "config.json");
await writeFile(configPath, JSON.stringify({
  op_id: opId,
  name: "Store OP",
  redirect_url: "https://client.example/callback",
  client_type: "public",
  client_id: "client_store12345678",
  scopes: ["openid"],
  features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
  experimental: { par: {} },
}));
const generated = await generateOp(opId, configPath);
const output = path.join(temporary, "persistence.mjs");
await build({
  entryPoints: [path.join(generated.appDirectory, "src/oidc-provider/persistence.ts")],
  bundle: true, platform: "node", format: "esm", outfile: output,
});
const { createD1ParStore, createD1ProviderStores, createD1StoreBackend, createD1UserStore } =
  await import(`${pathToFileURL(output).href}?${Date.now()}`);

test("the backend namespaces every key by op_id and never stores the raw key", async () => {
  const DB = new MemoryD1();
  const first = createD1StoreBackend(DB, "maronn-op-first000000");
  const second = createD1StoreBackend(DB, "maronn-op-second00000");

  await first.put("access-token:super-secret-token", { sub: "alice" }, 600);
  assert.deepEqual(await first.get("access-token:super-secret-token"), { sub: "alice" });
  assert.equal(await second.get("access-token:super-secret-token"), null, "another OP must not see it");
  assert.equal([...DB.records.keys()].some((key) => key.includes("super-secret-token")), false, "bearer values must not be stored in the clear");
  // The prefix goes to the indexed `kind` column; only the remainder is hashed.
  assert.deepEqual(DB.kindsInUse(), ["access-token:"]);

  await first.delete("access-token:super-secret-token");
  assert.equal(await first.get("access-token:super-secret-token"), null);
});

test("expired entries read as absent and are left out of list()", async () => {
  const DB = new MemoryD1();
  const backend = createD1StoreBackend(DB, "maronn-op-expiry00000");
  await backend.put("transaction:live", { keep: true }, 600);
  await backend.put("transaction:dead", { keep: false }, 600);
  // Force the second row to be stale the way a slow flow would.
  for (const [key, row] of DB.records) if (row.value_json.includes("false")) DB.records.set(key, { ...row, expires_at: Date.now() - 1 });

  assert.deepEqual(await backend.get("transaction:dead"), null);
  const listed = await backend.list("transaction:");
  assert.deepEqual(listed.map((entry) => entry.value), [{ keep: true }]);
});

test("keys returned by list() can be handed straight back to delete()", async () => {
  const DB = new MemoryD1();
  const backend = createD1StoreBackend(DB, "maronn-op-revoke00000");
  await backend.put("refresh-token:token-a", { grantId: "grant-1" }, 600);
  await backend.put("refresh-token:token-b", { grantId: "grant-2" }, 600);

  // This is exactly what the generated revokeByGrantId does.
  const entries = await backend.list("refresh-token:");
  for (const entry of entries.filter((item) => item.value.grantId === "grant-1")) await backend.delete(entry.key);

  assert.equal(await backend.get("refresh-token:token-a"), null);
  assert.deepEqual(await backend.get("refresh-token:token-b"), { grantId: "grant-2" });
});

test("accounts authenticate against the salted hash and nothing else", async () => {
  const DB = new MemoryD1();
  await DB.addUser("maronn-op-users000000", "alice", "password-123");
  const users = createD1UserStore(DB, "maronn-op-users000000");

  assert.equal((await users.authenticate("alice", "password-123")).sub, "alice");
  assert.equal(await users.authenticate("alice", "wrong-password"), undefined);
  assert.equal(await users.authenticate("testuser", "password"), undefined, "the CLI fixture account must not exist");
  assert.equal((await users.getClaims("alice")).email, "alice@example.com");
  assert.equal(await users.getClaims("nobody"), undefined);
});

test("the provider store set replaces the generated user store", async () => {
  const DB = new MemoryD1();
  const stores = createD1ProviderStores(DB, "maronn-op-stores00000");
  for (const name of ["transactionStore", "authCodeStore", "accessTokenStore", "refreshTokenStore", "authSessionStore", "browserSessionStore", "consentStore", "userStore"]) {
    assert.ok(stores[name], `missing ${name}`);
  }
  // The generated JSON user store seeds a fixture on a miss; ours must not.
  assert.equal(await stores.userStore.authenticate("testuser", "password"), undefined);
  assert.equal(DB.records.size, 0, "a failed login must not write anything");
});

test("a pushed request_uri is removed and returned in one statement", async () => {
  const DB = new MemoryD1();
  const store = createD1ParStore(DB, "maronn-op-parstore000");
  const record = {
    requestUri: "urn:ietf:params:oauth:request_uri:abc",
    clientId: "client_store12345678",
    params: { client_id: "client_store12345678", scope: "openid" },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  await store.save(record);
  assert.equal([...DB.records.keys()].some((key) => key.includes("abc")), false, "the reference value must not be stored in the clear");

  const consumed = await store.consume(record.requestUri);
  assert.equal(consumed.clientId, record.clientId);
  assert.deepEqual(consumed.params, record.params);
  assert.ok(consumed.expiresAt instanceof Date);
  assert.equal(await store.consume(record.requestUri), null, "a request_uri is single use");

  const statements = DB.statements.filter((entry) => entry.sql.includes("par-request:") || entry.params.includes("par-request:"));
  assert.ok(statements.some((entry) => entry.sql.startsWith("DELETE FROM oidc_records") && entry.sql.includes("RETURNING")));
  assert.equal(statements.filter((entry) => entry.sql.startsWith("SELECT")).length, 0, "consume must not read before deleting");
});
