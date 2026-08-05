import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { importModule } from "./support/build.mjs";

/**
 * Server render versus browser render.
 *
 * `hydrate()` adopts whatever markup it finds rather than diffing it, so a divergence
 * between the two renders is reported nowhere — it leaves the page subtly wrong until
 * something re-renders. What makes hydration safe is that the browser's tree has the same
 * shape as the one the Worker sent, and that is what these check, without a browser.
 *
 * The comparison is structural rather than textual on purpose: preact-render-to-string and
 * a DOM serializer disagree about attribute order and about how a boolean renders, and
 * neither of those is something hydration cares about.
 */

const { clientMarkup, hydrateInto, serverMarkup } = await importModule("test/support/hydrate-entry.tsx");

function browser(body = "<div id='root'></div>") {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  for (const key of ["document", "Node", "Element", "HTMLElement", "Text", "Event", "MutationObserver"]) {
    globalThis[key] = key === "document" ? document : document.defaultView[key];
  }
  return document;
}

/** The tree's shape: every element, in document order, with the identity a person would use. */
function shape(root) {
  return [...root.querySelectorAll("*")].map((element) =>
    [
      element.tagName.toLowerCase(),
      element.getAttribute("id") ?? "",
      element.getAttribute("class") ?? "",
      element.getAttribute("type") ?? "",
    ].join("|"),
  );
}

test("the browser's first render has the same shape and words as the markup the Worker sent", () => {
  const document = browser();
  const server = document.createElement("div");
  server.innerHTML = serverMarkup();
  const rendered = document.createElement("div");
  rendered.innerHTML = clientMarkup(document.getElementById("root"));

  assert.ok(shape(server).length > 50, "the form should be substantial enough for this to mean something");
  // This is the assertion that catches a divergence. The hydration test below cannot: Preact
  // keeps whatever the server sent, so a wrong class or a wrong word survives it silently.
  assert.deepEqual(shape(rendered), shape(server));
  assert.equal(rendered.textContent.replace(/\s+/g, " ").trim(), server.textContent.replace(/\s+/g, " ").trim());
});

test("hydrating the server's markup adopts its nodes instead of replacing them", () => {
  const document = browser();
  const root = document.getElementById("root");
  root.innerHTML = serverMarkup();

  const before = shape(root);
  // A sample from the top, middle and bottom of the tree. Preact only reuses a node when the
  // vnode it is hydrating against matches it, so identity surviving is the real signal.
  const sampled = ["#redirect-url", "#client-type", ".experimental-toggle-input", "#users .username", "#submit"].map(
    (selector) => {
      const node = root.querySelector(selector);
      assert.ok(node, `${selector} is missing from the server render`);
      return [selector, node];
    },
  );

  hydrateInto(root);

  assert.deepEqual(shape(root), before, "hydration must not add, drop or reshape any element");
  for (const [selector, node] of sampled) {
    assert.equal(root.querySelector(selector), node, `${selector} was replaced instead of hydrated`);
  }
});

test("the controls the server renders disabled are the ones hydration takes over", () => {
  const document = browser();
  const root = document.getElementById("root");
  root.innerHTML = serverMarkup();
  const wrapper = root.querySelector(".form-body");
  assert.ok(wrapper.hasAttribute("disabled"), "the form must not accept input before its reducer exists");
  hydrateInto(root);
  // hydrate() does not touch attributes, so the guard is still up immediately afterwards; it
  // is the effect-driven re-render that lifts it.
  assert.ok(root.querySelector(".form-body").hasAttribute("disabled"));
});
