import type { Context } from 'hono';
import type { KvDatabase } from './database.js';
import { createD1KvDatabase } from '../persistence.js';

/**
 * The key-value store the generated OP keeps its data in (the CLI generates it with --db kv
 * and leaves this one file to the project): the shared D1, namespaced by op_id. The Worker
 * entrypoint (templates/cloudflare/index.ts) hands the same stores to the app explicitly;
 * this covers what the generated app reads straight from createDatabase(c), such as the
 * clients' registered public keys.
 */
export function createDatabase(c: Context): KvDatabase {
  const env = c.env as { DB: D1Database; OP_ID: string };
  return createD1KvDatabase(env.DB, env.OP_ID);
}
