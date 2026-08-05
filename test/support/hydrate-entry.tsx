import { hydrate, render } from "preact";
import { renderToString } from "preact-render-to-string";
import { App } from "../../system/portal/src/ui/App";

/**
 * A single bundle holding the server renderer, the browser renderer and the component tree,
 * so test/portal-hydration.test.mjs compares the two with one copy of Preact. Built by
 * `importModule`, never shipped.
 */
export function serverMarkup(): string {
  return renderToString(<App />);
}

export function clientMarkup(container: Element): string {
  render(<App />, container);
  return container.innerHTML;
}

export function hydrateInto(container: Element): void {
  hydrate(<App />, container);
}
