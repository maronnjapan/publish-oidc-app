import { index, primaryKey, sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

/**
 * The shared D1, described once for every Worker that touches it.
 *
 * All OIDC state is namespaced by `op_id`: one database holds every published OP, and the
 * reaper deletes an OP by deleting its rows from each table. The DDL that creates these
 * tables lives in `./ddl.mjs` (see the note there); `test/db-schema.test.mjs` keeps the two
 * in step, so a column added here without the matching DDL fails the build.
 */

/** A creation request from the portal, from dispatch through to the deployed OP URL. */
export const registryRequests = sqliteTable(
  "registry_requests",
  {
    requestId: text("request_id").primaryKey(),
    status: text("status").$type<RequestStatus>().notNull(),
    opId: text("op_id").notNull().unique(),
    name: text("name").notNull(),
    /** The deployment config, cleared once CI has moved the client secret into a Worker secret. */
    configJson: text("config_json"),
    url: text("url"),
    error: text("error"),
    ipKey: text("ip_key").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_registry_requests_status").on(table.status, table.createdAt)],
);

/** The ledger of live OP Workers. The reaper only ever deletes a Worker named here. */
export const registryOps = sqliteTable(
  "registry_ops",
  {
    opId: text("op_id").primaryKey(),
    scriptName: text("script_name").notNull().unique(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    clientId: text("client_id").notNull(),
    clientType: text("client_type").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopesJson: text("scopes_json").notNull(),
    featuresJson: text("features_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    status: text("status").notNull().default("active"),
  },
  (table) => [index("idx_registry_ops_expiry").on(table.status, table.expiresAt)],
);

/** Per-IP and global creation counters, one row per UTC day. */
export const registryRateLimits = sqliteTable(
  "registry_rate_limits",
  {
    scope: text("scope").$type<RateLimitScope>().notNull(),
    key: text("key").notNull(),
    dateUtc: text("date_utc").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key, table.dateUtc] })],
);

/** Login accounts of a published OP. Passwords are salted SHA-256, never plaintext. */
export const oidcUsers = sqliteTable(
  "oidc_users",
  {
    opId: text("op_id").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordIterations: integer("password_iterations").notNull(),
    claimsJson: text("claims_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.opId, table.username] })],
);

/** Generic OIDC state (codes, tokens, transactions, sessions), keyed by an opaque digest. */
export const oidcRecords = sqliteTable(
  "oidc_records",
  {
    opId: text("op_id").notNull(),
    kind: text("kind").notNull(),
    recordKey: text("record_key").notNull(),
    valueJson: text("value_json").notNull(),
    expiresAt: integer("expires_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.opId, table.kind, table.recordKey] }),
    index("idx_oidc_records_expiry").on(table.opId, table.kind, table.expiresAt),
  ],
);

/** Remembered consent per subject and client. */
export const oidcConsents = sqliteTable(
  "oidc_consents",
  {
    opId: text("op_id").notNull(),
    subject: text("subject").notNull(),
    clientId: text("client_id").notNull(),
    scopesJson: text("scopes_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.opId, table.subject, table.clientId] })],
);

/** Grant ids issued against a remembered consent. */
export const oidcConsentGrants = sqliteTable(
  "oidc_consent_grants",
  {
    opId: text("op_id").notNull(),
    subject: text("subject").notNull(),
    clientId: text("client_id").notNull(),
    grantId: text("grant_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.opId, table.subject, table.clientId, table.grantId] })],
);

export type RequestStatus = "pending" | "generating" | "deployed" | "failed";
export type RateLimitScope = "ip" | "global";

/**
 * The tables the reaper clears for one OP, in deletion order: children before the ledger
 * rows, so a failure part way through leaves the OP visible for the next cron run.
 */
export const OP_SCOPED_TABLES = [
  oidcConsentGrants,
  oidcConsents,
  oidcRecords,
  oidcUsers,
  registryRequests,
  registryOps,
] as const;
