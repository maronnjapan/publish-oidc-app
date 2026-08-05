import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../../../db/client";
import { registryRateLimits } from "../../../../db/schema";
import type { Env } from "../../env";

/**
 * Two daily counters guard the portal: one per client IP and one for the whole deployment.
 * Both reset at UTC midnight, and both live in D1 so every isolate of the Worker sees the
 * same number.
 */

export const DEFAULT_PER_IP_LIMIT = 10;
export const DEFAULT_GLOBAL_LIMIT = 50;

export function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsFor(env: Pick<Env, "RATE_LIMIT_PER_IP_PER_DAY" | "RATE_LIMIT_GLOBAL_PER_DAY">) {
  return {
    perIp: parseLimit(env.RATE_LIMIT_PER_IP_PER_DAY, DEFAULT_PER_IP_LIMIT),
    global: parseLimit(env.RATE_LIMIT_GLOBAL_PER_DAY, DEFAULT_GLOBAL_LIMIT),
  };
}

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds until the counters reset, for the `Retry-After` of a rejected creation. */
export function retryAfterUtcMidnight(now = new Date()): string {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return String(Math.max(1, Math.ceil((next - now.getTime()) / 1000)));
}

/**
 * Claiming a slot is one statement so two concurrent requests cannot read the same count and
 * both decide they are under the limit.
 */
async function increment(db: Database, scope: "ip" | "global", key: string, date: string): Promise<number> {
  const rows = await db
    .insert(registryRateLimits)
    .values({ scope, key, dateUtc: date, count: 1 })
    .onConflictDoUpdate({
      target: [registryRateLimits.scope, registryRateLimits.key, registryRateLimits.dateUtc],
      set: { count: sql`${registryRateLimits.count} + 1` },
    })
    .returning({ count: registryRateLimits.count });
  const count = rows[0]?.count;
  if (count === undefined) throw new Error("rate-limit counter returned no row");
  return Number(count);
}

export async function currentUsage(db: Database, key: string, date: string): Promise<number> {
  const row = await db
    .select({ count: registryRateLimits.count })
    .from(registryRateLimits)
    .where(
      and(
        eq(registryRateLimits.scope, "ip"),
        eq(registryRateLimits.key, key),
        eq(registryRateLimits.dateUtc, date),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Both counters are claimed up front. When the global limit is what rejects the request the
 * per-IP claim is given back, so a busy day cannot silently eat somebody's personal quota.
 */
export async function applyRateLimit(
  db: Database,
  env: Pick<Env, "RATE_LIMIT_PER_IP_PER_DAY" | "RATE_LIMIT_GLOBAL_PER_DAY">,
  key: string,
  date: string,
): Promise<boolean> {
  const limits = limitsFor(env);
  if ((await increment(db, "ip", key, date)) > limits.perIp) return false;
  if ((await increment(db, "global", "*", date)) <= limits.global) return true;
  await db
    .update(registryRateLimits)
    .set({ count: sql`CASE WHEN ${registryRateLimits.count} > 0 THEN ${registryRateLimits.count} - 1 ELSE 0 END` })
    .where(
      and(
        eq(registryRateLimits.scope, "ip"),
        eq(registryRateLimits.key, key),
        eq(registryRateLimits.dateUtc, date),
      ),
    );
  return false;
}
