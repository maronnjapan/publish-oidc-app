import assert from "node:assert/strict";
import test from "node:test";
import { importModules, portalHtml } from "./support/build.mjs";

/**
 * What the Worker renders.
 *
 * The form is server-rendered and then hydrated by the same component tree, so this is both
 * the no-JavaScript experience and the markup hydration has to line up with. The assertions
 * are about the contract the catalogs describe, not about how a component happens to be
 * written.
 */

const html = await portalHtml();
const { catalog, document: renderer } = await importModules({
  catalog: "system/portal/src/shared/catalog.ts",
  document: "system/portal/src/server/document.tsx",
});

test("the document hydrates one root and loads no inline code", () => {
  assert.match(html, /^<!doctype html><html lang="ja">/);
  assert.match(html, /<div id="root">/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.[0-9a-f]{16}\.css">/);
  assert.match(html, /<script src="\/assets\/app\.[0-9a-f]{16}\.js" defer><\/script>/);
  // Exactly one script element, and it has a src: anything inline would need a CSP that
  // allows inline scripts, which is what this rewrite removed.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][2], "");
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.doesNotMatch(html, /\son[a-z]+="/, "no inline event handler attributes");
  // `style-src 'self'` blocks the style attribute too, so a `style={{…}}` prop would be
  // silently dropped by the browser rather than reported.
  assert.doesNotMatch(html, /\sstyle="/, "no inline style attributes");
});

test("the form arrives disabled and is only enabled once the reducer is live", () => {
  // Between the server render and hydration, anything typed would live in the DOM and not in
  // the reducer, and the first re-render after hydration would throw it away.
  assert.match(html, /<fieldset class="form-body" disabled aria-busy="true">/);
  assert.match(html, /<noscript>/);
});

test("rendering is deterministic, so the browser hydrates the markup it was sent", () => {
  // Nothing request-specific reaches the tree, so two renders — and therefore the server's
  // render and the browser's first render — produce the same markup.
  assert.equal(renderer.renderApp(), renderer.renderApp());
  assert.ok(renderer.renderDocument().includes(`<div id="root">${renderer.renderApp()}</div>`));
});

test("the form carries every control the creation API requires", () => {
  for (const marker of [
    'id="redirect-url"',
    'id="client-type"',
    'id="name"',
    'id="add-user"',
    'id="user-count"',
    'id="submit"',
    'type="file"',
    "username,password",
  ]) {
    assert.ok(html.includes(marker), `${marker} is missing from the form`);
  }
});

test("every selectable item is rendered with the summary its catalog gives it", () => {
  for (const group of catalog.CHOICE_GROUPS) {
    for (const item of group.items) {
      assert.ok(html.includes(item.summary), `${group.id}.${item.id} summary is missing from the form`);
      assert.ok(html.includes(item.label), `${group.id}.${item.id} label is missing from the form`);
    }
  }
  for (const feature of [...catalog.OPTIONAL_FEATURES, ...catalog.EXPERIMENTAL_FEATURES]) {
    assert.ok(html.includes(feature.summary), `${feature.id} summary is missing from the form`);
    for (const option of feature.options ?? []) {
      assert.ok(html.includes(`data-feature="${feature.id}" data-option="${option.id}"`), `${feature.id}.${option.id}`);
    }
  }
});

test("every reference opens in a new tab without leaking the portal", () => {
  const anchors = [...html.matchAll(/<a ([^>]*)>/g)].map((match) => match[1]);
  assert.ok(anchors.length > 0);
  for (const attributes of anchors) {
    assert.match(attributes, /rel="noopener noreferrer"/);
    assert.match(attributes, /target="_blank"/);
    assert.match(attributes, /href="https:\/\//);
  }
});

test("the experimental section warns that the package is unstable", () => {
  for (const feature of catalog.EXPERIMENTAL_FEATURES) {
    assert.match(html, new RegExp(`class="experimental-toggle-input" type="checkbox" value="${feature.id}"`));
  }
  assert.match(html, /他の機能より適切に動作しない可能性が高い/);
  assert.match(html, /マイナーリリースでも破壊的変更や削除が起こり得ます/);
});

test("the optional section is folded away and does not borrow the experimental warning", () => {
  for (const feature of catalog.OPTIONAL_FEATURES) {
    assert.match(html, new RegExp(`class="optional-toggle-input" type="checkbox" value="${feature.id}"`));
  }
  // Collapsed, not hidden: <details> without `open` keeps the toggles out of the way of the
  // people who will never set them, while staying one click from anyone who will.
  assert.match(html, /<details class="optional">/);
  assert.doesNotMatch(html, /<details class="optional" open>/);
  assert.match(html, /<summary>オプション機能（デフォルト無効/);
  const section = html.slice(html.indexOf('<details class="optional">'), html.indexOf("</details>"));
  assert.doesNotMatch(section, /他の機能より適切に動作しない/);
});

test("a feature that is not wired into the generator is never offered", async () => {
  const { readExperimentalCatalog, readOptionalCatalog } = await import("../scripts/lib.mjs");
  for (const [group, file] of [
    ["experimental", await readExperimentalCatalog()],
    ["optional", await readOptionalCatalog()],
  ]) {
    for (const feature of file.features.filter((entry) => entry.status !== "supported")) {
      assert.doesNotMatch(html, new RegExp(`class="${group}-toggle-input" type="checkbox" value="${feature.id}"`));
    }
  }
});

test("opt-in options start disabled, because their feature starts off", () => {
  for (const feature of [...catalog.OPTIONAL_FEATURES, ...catalog.EXPERIMENTAL_FEATURES]) {
    for (const option of feature.options ?? []) {
      const marker = `data-feature="${feature.id}" data-option="${option.id}"`;
      const row = html.slice(html.indexOf(marker), html.indexOf(marker) + 200);
      assert.match(row, /disabled/, `${feature.id}.${option.id} should not be settable before its feature is on`);
    }
  }
});

test("offline_access is selectable on arrival, because refresh tokens default to on", () => {
  // The rendered state has to be the state the reducer starts in, or hydration would swap
  // the control out from under whoever clicked it first. The coupling itself — turning
  // refresh tokens off disables and clears the scope — is covered in test/portal-form.
  const scope = 'class="scope" type="checkbox" value="offline_access"';
  const refresh = 'class="feature" type="checkbox" value="refresh-token"';
  assert.ok(html.includes(scope));
  assert.doesNotMatch(html.slice(html.indexOf(scope), html.indexOf(scope) + 120), /disabled/);
  assert.match(html.slice(html.indexOf(refresh), html.indexOf(refresh) + 120), /checked/);
  assert.doesNotMatch(html.slice(html.indexOf(scope), html.indexOf(scope) + 120), /checked/);
});

test("the page starts with one empty account row and a quota placeholder", () => {
  assert.equal([...html.matchAll(/class="username"/g)].length, 1);
  assert.match(html, /0 \/ 5件|1 \/ 5件/);
  assert.match(html, /本日の残り作成回数を確認しています…/);
});
