import type { Database } from "../../db/client";

/** The bindings `scripts/deploy-portal.mjs` installs on the portal Worker. */
export interface Env {
  DB: D1Database;
  RATE_LIMIT_PER_IP_PER_DAY: string;
  RATE_LIMIT_GLOBAL_PER_DAY: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_DISPATCH_TOKEN: string;
}

/**
 * `db` is put on the context by a middleware so every handler shares one Drizzle instance
 * per request and none of them has to know that the binding is called `DB`.
 */
export type AppEnv = {
  Bindings: Env;
  Variables: { db: Database };
};
