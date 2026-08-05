import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { parseCreateApp } from "../../shared/validation";
import { ipKey } from "../ip";
import { abandonCreation, findRequest, recordCreation } from "../services/creations";
import { dispatchWorkflow } from "../services/github";
import { applyRateLimit, currentUsage, limitsFor, retryAfterUtcMidnight, utcDate } from "../services/rate-limit";
import { noStore, sameOrigin, withDatabase } from "../middleware";

/** Bodies larger than this are rejected before they are read: the form sends a few KB. */
const MAX_BODY_BYTES = 20_000;

const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export const api = new Hono<AppEnv>();

api.use("*", noStore, withDatabase);

api.get("/quota", async (c) => {
  const limit = limitsFor(c.env).perIp;
  const used = await currentUsage(c.var.db, ipKey(c.req.header("CF-Connecting-IP") ?? null), utcDate());
  return c.json({ limit, used, remaining: Math.max(0, limit - used) });
});

api.get("/requests/:requestId", async (c) => {
  const requestId = c.req.param("requestId");
  const row = REQUEST_ID_PATTERN.test(requestId) ? await findRequest(c.var.db, requestId) : null;
  return row ? c.json(row) : c.json({ error: "not_found", message: "request was not found" }, 404);
});

/**
 * Creating an OP. The order matters: the request is proven to come from this portal before
 * anything is read, validated before the daily quota is spent, and only recorded once it is
 * known to be deployable — a body that fails validation costs the caller nothing.
 */
api.post("/apps", sameOrigin, async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large", message: "request body is too large" }, 413);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_input", message: "request body must be valid JSON" }, 400);
  }

  const parsed = parseCreateApp(raw);
  if (!parsed.ok) return c.json({ error: "invalid_input", message: parsed.message }, 400);

  const key = ipKey(c.req.header("CF-Connecting-IP") ?? null);
  if (!(await applyRateLimit(c.var.db, c.env, key, utcDate()))) {
    return c.json({ error: "rate_limited", message: "daily OP creation limit reached" }, 429, {
      "retry-after": retryAfterUtcMidnight(),
    });
  }

  const creation = await recordCreation(c.var.db, { input: parsed.value, ipKey: key });

  let dispatched = false;
  try {
    dispatched = await dispatchWorkflow(c.env, { request_id: creation.requestId, op_id: creation.opId });
  } catch (error) {
    console.error("workflow dispatch failed", error);
  }
  if (!dispatched) {
    await abandonCreation(c.var.db, {
      requestId: creation.requestId,
      opId: creation.opId,
      reason: "dispatch_failed",
    });
    return c.json({ error: "dispatch_failed", message: "failed to start the generation workflow" }, 502);
  }

  return c.json(
    {
      request_id: creation.requestId,
      client_id: creation.clientId,
      ...(creation.clientSecret ? { client_secret: creation.clientSecret } : {}),
    },
    202,
  );
});
