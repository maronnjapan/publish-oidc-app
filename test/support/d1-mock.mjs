import { webcrypto } from "node:crypto";
import { clientGrantTypes } from "../../scripts/deploy-op.mjs";

function base64Url(value) { return Buffer.from(value).toString("base64url"); }

/**
 * In-memory stand-in for the shared D1, covering exactly the statements
 * templates/cloudflare/persistence.ts issues. Statement granularity matters: D1 applies
 * `DELETE ... RETURNING` atomically, and the PAR single-use guarantee depends on it, so
 * that shape is modelled as one operation rather than a read followed by a delete.
 */
export class MemoryD1 {
  records = new Map();
  users = new Map();
  statements = [];

  #recordKey(params) { return `${params[0]}|${params[1]}|${params[2]}`; }

  #live(row, now = Date.now()) { return row && (row.expires_at === null || row.expires_at === undefined || row.expires_at > now); }

  prepare(sql) {
    const database = this;
    return {
      bind(...params) {
        return {
          async first() {
            database.statements.push({ sql, params });
            if (sql.startsWith("DELETE FROM oidc_records") && sql.includes("RETURNING")) {
              const key = database.#recordKey(params);
              const row = database.records.get(key) ?? null;
              database.records.delete(key);
              await Promise.resolve();
              return database.#live(row) ? row : null;
            }
            if (sql.includes("FROM oidc_records")) {
              const row = database.records.get(database.#recordKey(params)) ?? null;
              return row ? { value_json: row.value_json, expires_at: row.expires_at } : null;
            }
            if (sql.includes("password_hash") && sql.includes("FROM oidc_users")) {
              return database.users.get(`${params[0]}|${params[1]}`) ?? null;
            }
            if (sql.includes("SELECT claims_json FROM oidc_users")) {
              const user = database.users.get(`${params[0]}|${params[1]}`);
              return user ? { claims_json: user.claims_json } : null;
            }
            return null;
          },
          async all() {
            database.statements.push({ sql, params });
            if (sql.includes("FROM oidc_records") && sql.includes("expires_at IS NULL OR expires_at >")) {
              const results = [];
              for (const [key, row] of database.records) {
                const [opId, kind] = key.split("|");
                if (opId === params[0] && kind === params[1] && database.#live(row, params[2])) {
                  results.push({ record_key: row.record_key, value_json: row.value_json, expires_at: row.expires_at });
                }
              }
              return { success: true, results };
            }
            return { success: true, results: [] };
          },
          async run() {
            database.statements.push({ sql, params });
            if (sql.startsWith("INSERT INTO oidc_records")) {
              database.records.set(database.#recordKey(params), { record_key: params[2], value_json: params[3], expires_at: params[4], updated_at: params[5] });
            } else if (sql.startsWith("DELETE FROM oidc_records")) {
              database.records.delete(database.#recordKey(params));
            }
            return { success: true };
          },
        };
      },
    };
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }

  /** Keys are namespaced `op_id|kind|record_key`; kind carries the store prefix. */
  kindsInUse() {
    return [...new Set([...this.records.keys()].map((key) => key.split("|")[1]))].sort();
  }

  async addUser(opId, username, password, claims) {
    this.users.set(`${opId}|${username}`, await passwordRow(username, password, claims));
  }
}

/** Mirrors the salted SHA-256 the portal writes into oidc_users. */
export async function passwordRow(username, password, claims) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = new TextEncoder().encode(password);
  const saltedPassword = new Uint8Array(salt.length + passwordBytes.length);
  saltedPassword.set(salt);
  saltedPassword.set(passwordBytes, salt.length);
  const hash = await webcrypto.subtle.digest("SHA-256", saltedPassword);
  return {
    username,
    password_hash: base64Url(new Uint8Array(hash)),
    password_salt: base64Url(salt),
    password_iterations: 1,
    claims_json: JSON.stringify(claims ?? { sub: username, name: "Alice Example", preferred_username: username, email: "alice@example.com", email_verified: true }),
  };
}

export async function signingEnvironment(issuer, opId, config, DB, experimental = {}) {
  const keyPair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    DB,
    OP_ID: opId,
    OP_ISSUER: issuer,
    ALLOWED_SCOPES: JSON.stringify(config.scopes),
    OIDC_SIGNING_JWK: JSON.stringify({ ...privateJwk, alg: "RS256", use: "sig", kid: `${opId}-key` }),
    OIDC_CLIENT_CONFIG: JSON.stringify({
      clientId: config.client_id,
      ...(config.client_secret ? { clientSecret: config.client_secret } : {}),
      redirectUris: [config.redirect_url],
      clientType: config.client_type,
      offlineAccessAllowed: config.scopes.includes("offline_access"),
      grantTypes: clientGrantTypes(config.features, experimental),
      tokenEndpointAuthMethod: config.client_type === "public" ? "none" : "client_secret_post",
    }),
  };
}

export { base64Url };
