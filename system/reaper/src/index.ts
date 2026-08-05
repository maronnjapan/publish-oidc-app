import { and, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import { type Database, createDb } from "../../db/client";
import { OP_SCOPED_TABLES, registryOps, registryRateLimits, registryRequests } from "../../db/schema";

/**
 * The 24-hour reaper.
 *
 * Every 15 minutes it deletes the OP Workers whose time is up and the shared-D1 rows keyed
 * to them. It reads the same schema the portal writes (`system/db/schema.ts`), so a table
 * that gains a column cannot leave the reaper deleting a subset of an OP's data.
 */

interface Env {
  DB: D1Database;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
}

interface ReapTarget {
  op_id: string;
  script_name: string;
}

const OP_ID_PATTERN = /^maronn-op-[a-z0-9]{10,16}$/;
const MAX_OPS_PER_RUN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_RETENTION_DAYS = 7;

function apiUrl(env: Env, suffix: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID)}${suffix}`;
}

/**
 * The only defence against deleting a system Worker. A ledger row is data, and data can be
 * wrong, so the name is re-checked against the OP id pattern immediately before the delete.
 */
function assertTarget(target: ReapTarget): void {
  if (!OP_ID_PATTERN.test(target.op_id) || target.script_name !== target.op_id) {
    throw new Error(`refusing to delete non-OP Worker: ${target.script_name}`);
  }
}

async function deleteWorker(env: Env, scriptName: string): Promise<void> {
  const response = await fetch(apiUrl(env, `/workers/scripts/${encodeURIComponent(scriptName)}?force=true`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Worker delete failed for ${scriptName}: HTTP ${response.status}`);
  }
}

/** Children first, ledger rows last, so a partial failure leaves the OP visible next run. */
async function deleteOpData(db: Database, opId: string): Promise<void> {
  await db.batch(
    OP_SCOPED_TABLES.map((table) => db.delete(table).where(eq(table.opId, opId))) as unknown as Parameters<
      Database["batch"]
    >[0],
  );
}

/**
 * The Worker goes first: while it is alive it can still write the rows that are about to be
 * deleted, and a Worker without its data is inert rather than half-working.
 */
async function reapTarget(env: Env, db: Database, target: ReapTarget): Promise<void> {
  assertTarget(target);
  await deleteWorker(env, target.script_name);
  await deleteOpData(db, target.op_id);
}

function loadExpiredOps(db: Database, now: string): Promise<ReapTarget[]> {
  return db
    .select({ op_id: registryOps.opId, script_name: registryOps.scriptName })
    .from(registryOps)
    .where(
      and(eq(registryOps.status, "active"), isNotNull(registryOps.expiresAt), lte(registryOps.expiresAt, now)),
    )
    .orderBy(registryOps.expiresAt)
    .limit(MAX_OPS_PER_RUN)
    .all();
}

/**
 * Requests that never became a live OP. A deployment that failed after uploading the Worker
 * leaves no ledger row, so the request itself is what makes the orphan recoverable.
 */
async function loadStaleRequests(db: Database, cutoff: string, limit: number): Promise<ReapTarget[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select({ op_id: registryRequests.opId })
    .from(registryRequests)
    .leftJoin(registryOps, eq(registryOps.opId, registryRequests.opId))
    .where(
      and(lte(registryRequests.createdAt, cutoff), or(isNull(registryOps.opId), ne(registryOps.status, "active"))),
    )
    .orderBy(registryRequests.createdAt)
    .limit(limit)
    .all();
  return rows.map((row) => ({ op_id: row.op_id, script_name: row.op_id }));
}

async function runMaintenance(env: Env, now = new Date()): Promise<void> {
  const db = createDb(env.DB);
  const expired = await loadExpiredOps(db, now.toISOString());
  const expiredIds = new Set(expired.map((target) => target.op_id));
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const stale = await loadStaleRequests(db, cutoff, MAX_OPS_PER_RUN - expired.length);
  const targets = [...expired, ...stale.filter((target) => !expiredIds.has(target.op_id))];

  for (const target of targets) {
    try {
      await reapTarget(env, db, target);
    } catch (error) {
      console.error(`failed to reap ${target.op_id}`, error);
    }
  }

  const retainFrom = new Date(now.getTime() - RATE_LIMIT_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  await db.delete(registryRateLimits).where(lt(registryRateLimits.dateUtc, retainFrom));
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMaintenance(env).catch((error) => {
        console.error("reaper run failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { runMaintenance };
