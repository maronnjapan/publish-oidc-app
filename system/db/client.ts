import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * One Drizzle handle over the shared D1 binding. Handlers take this rather than the raw
 * `D1Database` so queries are written against `system/db/schema.ts` instead of SQL strings,
 * and so tests can pass any D1-compatible client (see test/support/d1-sqlite.mjs).
 */
export function createDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type Database = ReturnType<typeof createDb>;
export { schema };
