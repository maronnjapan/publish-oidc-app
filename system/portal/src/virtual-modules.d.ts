/**
 * The client bundle, built by esbuild and handed to the Worker bundle as strings.
 *
 * `scripts/portal-client.mjs` resolves this module: it runs a nested build of
 * `src/client/main.tsx`, hashes each output and produces the two assets below. Serving them
 * from the Worker rather than inlining them into the document is what lets the portal's
 * Content-Security-Policy forbid inline scripts and styles entirely.
 */
declare module "virtual:portal-client" {
  export interface ClientAsset {
    /** Content-addressed, so the assets can be cached forever. */
    path: string;
    code: string;
    contentType: string;
  }
  export const script: ClientAsset;
  export const stylesheet: ClientAsset;
}
