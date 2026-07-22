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

function apiUrl(env: Env, suffix: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID)}${suffix}`;
}

function assertTarget(target: ReapTarget): void {
  if (!OP_ID_PATTERN.test(target.op_id) || target.script_name !== target.op_id) {
    throw new Error(`refusing to delete non-OP Worker: ${target.script_name}`);
  }
}

async function deleteWorker(env: Env, scriptName: string): Promise<void> {
  const response = await fetch(
    apiUrl(env, `/workers/scripts/${encodeURIComponent(scriptName)}?force=true`),
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Worker delete failed for ${scriptName}: HTTP ${response.status}`);
  }
}

async function deleteOpData(env: Env, opId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oidc_consent_grants WHERE op_id = ?1").bind(opId),
    env.DB.prepare("DELETE FROM oidc_consents WHERE op_id = ?1").bind(opId),
    env.DB.prepare("DELETE FROM oidc_records WHERE op_id = ?1").bind(opId),
    env.DB.prepare("DELETE FROM oidc_users WHERE op_id = ?1").bind(opId),
    env.DB.prepare("DELETE FROM registry_requests WHERE op_id = ?1").bind(opId),
    env.DB.prepare("DELETE FROM registry_ops WHERE op_id = ?1").bind(opId),
  ]);
}

async function reapTarget(env: Env, target: ReapTarget): Promise<void> {
  assertTarget(target);
  await deleteWorker(env, target.script_name);
  await deleteOpData(env, target.op_id);
}

async function loadExpiredOps(env: Env, now: string): Promise<ReapTarget[]> {
  const result = await env.DB.prepare(
    `SELECT op_id, script_name
     FROM registry_ops
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?1
     ORDER BY expires_at
     LIMIT ?2`,
  )
    .bind(now, MAX_OPS_PER_RUN)
    .all<ReapTarget>();
  return result.results;
}

async function loadStaleRequests(
  env: Env,
  cutoff: string,
  limit: number,
): Promise<ReapTarget[]> {
  if (limit <= 0) return [];
  const result = await env.DB.prepare(
    `SELECT r.op_id, r.op_id AS script_name
     FROM registry_requests r
     LEFT JOIN registry_ops o ON o.op_id = r.op_id
     WHERE r.created_at <= ?1
       AND (o.op_id IS NULL OR o.status <> 'active')
     ORDER BY r.created_at
     LIMIT ?2`,
  )
    .bind(cutoff, limit)
    .all<ReapTarget>();
  return result.results;
}

async function runMaintenance(env: Env, now = new Date()): Promise<void> {
  const expired = await loadExpiredOps(env, now.toISOString());
  const expiredIds = new Set(expired.map((target) => target.op_id));
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const stale = await loadStaleRequests(env, cutoff, MAX_OPS_PER_RUN - expired.length);
  const targets = [...expired, ...stale.filter((target) => !expiredIds.has(target.op_id))];

  for (const target of targets) {
    try {
      await reapTarget(env, target);
    } catch (error) {
      console.error(`failed to reap ${target.op_id}`, error);
    }
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM registry_rate_limits WHERE date_utc < ?1")
    .bind(sevenDaysAgo)
    .run();
}

export default {
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runMaintenance(env).catch((error) => {
        console.error("reaper run failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { runMaintenance };
