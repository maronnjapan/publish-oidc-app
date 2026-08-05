import { eq } from "drizzle-orm";
import type { Database } from "../../../../db/client";
import { oidcUsers, registryRequests } from "../../../../db/schema";
import type { CreateAppInput, RequestStatusResponse } from "../../shared/validation";
import { allocateClientId, allocateClientSecret, allocateOpId, hashPassword } from "./credentials";

/**
 * The D1 side of creating an OP: the request ledger row, the accounts that OP will accept,
 * and the rollback that runs when the generation workflow could not be started.
 */

export interface Creation {
  requestId: string;
  opId: string;
  clientId: string;
  clientSecret: string | null;
}

/** The config CI reads back to generate and deploy the OP. */
function deploymentConfig(input: CreateAppInput, creation: Creation) {
  return {
    name: input.name || creation.opId,
    redirect_url: input.redirectUrl,
    client_type: input.clientType,
    client_id: creation.clientId,
    client_secret: creation.clientSecret,
    scopes: input.scopes,
    features: input.features,
    optional: input.optional,
    experimental: input.experimental,
  };
}

/**
 * Written as one batch so a Worker that dies midway cannot leave accounts behind without the
 * request that owns them — the reaper finds OPs through the request ledger.
 */
export async function recordCreation(
  db: Database,
  { input, ipKey, now = new Date() }: { input: CreateAppInput; ipKey: string; now?: Date },
): Promise<Creation> {
  const creation: Creation = {
    requestId: crypto.randomUUID(),
    opId: allocateOpId(now.getTime()),
    clientId: allocateClientId(),
    clientSecret: input.clientType === "confidential" ? allocateClientSecret() : null,
  };
  const timestamp = now.toISOString();
  const hashed = await Promise.all(
    input.users.map(async (user) => ({ username: user.username, ...(await hashPassword(user.password)) })),
  );

  await db.batch([
    db.insert(registryRequests).values({
      requestId: creation.requestId,
      status: "pending",
      opId: creation.opId,
      name: input.name || creation.opId,
      configJson: JSON.stringify(deploymentConfig(input, creation)),
      ipKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    ...hashed.map((user) =>
      db.insert(oidcUsers).values({
        opId: creation.opId,
        username: user.username,
        passwordHash: user.hash,
        passwordSalt: user.salt,
        passwordIterations: user.iterations,
        claimsJson: JSON.stringify({ sub: user.username, name: user.username, preferred_username: user.username }),
        createdAt: timestamp,
      }),
    ),
  ] as unknown as Parameters<Database["batch"]>[0]);

  return creation;
}

/**
 * Undo a creation that never reached CI. The config — which still holds the client secret —
 * is cleared rather than kept for a retry: the secret was already shown to the browser, and
 * a retry mints a new one.
 */
export async function abandonCreation(
  db: Database,
  { requestId, opId, reason, now = new Date() }: { requestId: string; opId: string; reason: string; now?: Date },
): Promise<void> {
  await db.batch([
    db
      .update(registryRequests)
      .set({ status: "failed", error: reason, configJson: null, updatedAt: now.toISOString() })
      .where(eq(registryRequests.requestId, requestId)),
    db.delete(oidcUsers).where(eq(oidcUsers.opId, opId)),
  ] as unknown as Parameters<Database["batch"]>[0]);
}

/** The status the browser polls. The config and the IP key never leave the database. */
export async function findRequest(db: Database, requestId: string): Promise<RequestStatusResponse | null> {
  const row = await db
    .select({
      request_id: registryRequests.requestId,
      status: registryRequests.status,
      op_id: registryRequests.opId,
      url: registryRequests.url,
      error: registryRequests.error,
      created_at: registryRequests.createdAt,
    })
    .from(registryRequests)
    .where(eq(registryRequests.requestId, requestId))
    .get();
  return row ?? null;
}
