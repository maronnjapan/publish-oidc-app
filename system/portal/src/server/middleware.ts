import { createMiddleware } from "hono/factory";
import { createDb } from "../../../db/client";
import type { AppEnv } from "../env";

/**
 * Cross-cutting request handling, kept out of the handlers themselves.
 */

/**
 * The document loads a stylesheet and a script from this origin, calls this origin's own
 * API, and does nothing else — so the policy denies everything by default and names only
 * what the page actually needs. Nothing inline is permitted, which also means a component
 * may not use a `style={{…}}` prop: `style-src 'self'` blocks the attribute those become.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** Applied to every response, including the JSON API and the assets. */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header("content-security-policy", CONTENT_SECURITY_POLICY);
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
});

/** One Drizzle handle per request, so no handler has to know the binding's name. */
export const withDatabase = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

/** Nothing under /api may be cached: quotas, statuses and credentials are all per-request. */
export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

/**
 * The creation endpoint is only ever called by the portal's own page. Requiring the Origin
 * to name this exact host is what keeps another site from spending a visitor's daily quota.
 */
export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  if (!host || !origin || origin !== `https://${host}`) {
    return c.json({ error: "origin_mismatch", message: "Origin does not match this portal" }, 403);
  }
  await next();
});
