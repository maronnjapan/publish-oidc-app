import { Hono } from "hono";
import type { AppEnv } from "../env";
import { renderDocument } from "./document";
import { securityHeaders } from "./middleware";
import { api } from "./routes/api";
import { assets } from "./routes/assets";

/**
 * The portal Worker, assembled.
 *
 * Three surfaces, each in its own module: the rendered page, the hashed client assets, and
 * the JSON API. Adding a route means adding it to one of them rather than extending a chain
 * of method-and-path comparisons.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders);

  // The document names its assets by content hash and they are served `immutable`, so a
  // cached copy of the page outliving a deploy would ask for a hash that no longer exists
  // and get a form with no script behind it. The page itself is therefore never cached.
  app.get("/", (c) => c.html(renderDocument(), 200, { "cache-control": "no-store" }));
  app.route("/", assets);
  app.route("/api", api);

  app.notFound((c) => c.json({ error: "not_found", message: "route was not found" }, 404));
  app.onError((error, c) => {
    console.error("portal request failed", error);
    return c.json({ error: "internal_error", message: "an internal error occurred" }, 500);
  });

  return app;
}

export type PortalApp = ReturnType<typeof createApp>;
