import { renderToString } from "preact-render-to-string";
import { script, stylesheet } from "virtual:portal-client";
import { App } from "../ui/App";

/**
 * The portal page.
 *
 * The form is rendered here and hydrated by the same component tree in the browser, so the
 * markup is complete and readable before the script arrives. Nothing request-specific is
 * baked in — the daily quota is fetched after hydration — which is what makes the document a
 * constant that can be rendered once per isolate.
 */

const HEAD = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>Maronn OIDC Provider Publisher</title>",
  `<link rel="stylesheet" href="${stylesheet.path}">`,
  `<script src="${script.path}" defer></script>`,
].join("");

/** The hydration root's contents. Must be reproducible: the browser renders it again. */
export function renderApp(): string {
  return renderToString(<App />);
}

let cached: string | null = null;

export function renderDocument(): string {
  cached ??= `<!doctype html><html lang="ja"><head>${HEAD}</head><body><div id="root">${renderApp()}</div></body></html>`;
  return cached;
}
