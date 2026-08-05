import { createApp } from "./server/app";

/**
 * The portal Worker.
 *
 * The implementation lives under `server/` (Hono routes, Drizzle over the shared D1),
 * `ui/` (the Preact form, rendered here and hydrated in the browser) and `shared/` (the
 * rules and catalogs both ends enforce). This file only wires the app to the runtime.
 */
const app = createApp();

export default app;
export { createApp };
