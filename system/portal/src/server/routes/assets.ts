import { Hono } from "hono";
import { script, stylesheet } from "virtual:portal-client";
import type { AppEnv } from "../../env";

/**
 * The client bundle and the stylesheet, served by the Worker itself.
 *
 * There is no static-asset binding in this deployment — the portal is uploaded as a single
 * module — so the build embeds both files and they are served from here. Their paths carry a
 * content hash, which is what makes an immutable cache safe: a new build is a new URL.
 */
export const assets = new Hono<AppEnv>();

const IMMUTABLE = "public, max-age=31536000, immutable";

for (const asset of [script, stylesheet]) {
  assets.get(asset.path, (c) =>
    c.body(asset.code, 200, { "content-type": asset.contentType, "cache-control": IMMUTABLE }),
  );
}
