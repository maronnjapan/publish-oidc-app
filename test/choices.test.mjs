import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  choiceGroup,
  readChoiceCatalog,
  readExperimentalCatalog,
  readOptionalCatalog,
  supportedFeatures,
  validateLinks,
} from "../scripts/lib.mjs";
import { importModules, portalHtml } from "./support/build.mjs";

/**
 * The catalogs are the single source of truth for what the form offers and for how each
 * item is described. These tests are about the catalog contract itself — that its ids match
 * the lists the code enforces, and that every link it declares resolves to something real.
 * What the rendered form does with them is test/portal-ui.test.mjs.
 */

const { catalog: portalCatalog, rules } = await importModules({
  catalog: "system/portal/src/shared/catalog.ts",
  rules: "system/portal/src/shared/rules.ts",
});
const { CHOICE_GROUPS, choiceItems, linkHref } = portalCatalog;
const { FEATURE_NAMES, OPTIONAL_SCOPES, REQUIRED_SCOPE } = rules;

const catalog = await readChoiceCatalog();
const infra = JSON.parse(await readFile("infra.json", "utf8"));
const experimentalCatalog = await readExperimentalCatalog();
const optionalCatalog = await readOptionalCatalog();

function everyItem() {
  return catalog.groups.flatMap((group) => group.items.map((item) => ({ group: group.id, item })));
}

test("every selectable item carries a one-line summary", () => {
  // readChoiceCatalog() enforces the shape; this asserts the catalog actually covers the
  // whole form rather than a subset of it.
  for (const groupId of ["client-type", "scope", "feature"]) {
    assert.ok(choiceGroup(catalog, groupId).items.length > 0, `${groupId} has no items`);
  }
  for (const { group, item } of everyItem()) {
    assert.ok(item.summary.trim().length > 0, `${group}.${item.id} has an empty summary`);
  }
  for (const feature of [...supportedFeatures(experimentalCatalog), ...supportedFeatures(optionalCatalog)]) {
    assert.ok(feature.summary.trim().length > 0, `${feature.id} has an empty summary`);
  }
});

test("catalog ids match the lists the portal, generator and follow-up check enforce", async () => {
  const ids = (groupId) => choiceGroup(catalog, groupId).items.map((item) => item.id);
  assert.deepEqual(ids("client-type"), ["public", "confidential"]);
  assert.deepEqual(ids("scope"), [REQUIRED_SCOPE, ...OPTIONAL_SCOPES]);
  assert.deepEqual(ids("feature"), [...FEATURE_NAMES]);

  // The generator and the weekly follow-up keep their own copies of the feature list; a
  // choice catalog that drifts from them would describe an item the OP never gets.
  const literal = (source, name) => JSON.parse(source.match(new RegExp(`${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
  assert.deepEqual(literal(await readFile("scripts/generate-op.mjs", "utf8"), "const FEATURES"), [...FEATURE_NAMES]);
  assert.deepEqual(literal(await readFile("scripts/check-package-updates.mjs", "utf8"), "const KNOWN_CLI_FEATURES"), [...FEATURE_NAMES]);
});

test("declared links resolve, and repository links point at a file that exists", async () => {
  const links = [
    ...everyItem().flatMap(({ group, item }) => (item.links ?? []).map((link) => ({ where: `${group}.${item.id}`, link }))),
    ...[...experimentalCatalog.features, ...optionalCatalog.features].flatMap((feature) => [
      ...(feature.links ?? []).map((link) => ({ where: feature.id, link })),
      ...(feature.options ?? []).flatMap((option) => (option.links ?? []).map((link) => ({ where: `${feature.id}.${option.id}`, link }))),
    ]),
  ];
  assert.ok(links.length > 0);
  for (const { where, link } of links) {
    const href = linkHref(link);
    assert.ok(href, `${where}: link ${link.label} does not resolve to a URL`);
    assert.match(href, /^https:\/\//, `${where}: links must be https`);
    if (link.doc) {
      await access(link.doc);
      assert.equal(href, `https://github.com/${infra.github_owner}/${infra.github_repo}/blob/main/${link.doc}`);
    }
  }
});

test("a malformed link is rejected instead of rendered", () => {
  assert.throws(() => validateLinks([{ label: "no target" }], "test"), /exactly one of url or doc/);
  assert.throws(() => validateLinks([{ label: "both", url: "https://example.com", doc: "README.md" }], "test"), /exactly one of url or doc/);
  assert.throws(() => validateLinks([{ label: "insecure", url: "http://example.com" }], "test"), /https/);
  assert.throws(() => validateLinks([{ label: "escaping", doc: "../secrets.md" }], "test"), /inside this repository/);
  assert.throws(() => validateLinks([{ url: "https://example.com" }], "test"), /needs a label/);
});

test("links are optional: an item without them renders no anchor", async () => {
  const html = await portalHtml();
  // PAR's `required` option is the live example of a described choice with no link.
  const optionRow = html.slice(html.indexOf('data-option="required"'), html.indexOf('data-option="required"') + 600);
  assert.match(optionRow, /require_pushed_authorization_requests=true/);
  assert.doesNotMatch(optionRow.slice(0, optionRow.indexOf("</div>")), /<a /);
  assert.equal(linkHref({ label: "no target" }), null);
  assert.equal(linkHref({ label: "empty doc", doc: "" }), null);
});

test("every declared link reaches the form", async () => {
  const html = await portalHtml();
  const declared = [
    ...everyItem().flatMap(({ item }) => item.links ?? []),
    ...[...supportedFeatures(experimentalCatalog), ...supportedFeatures(optionalCatalog)].flatMap((feature) => [
      ...(feature.links ?? []),
      ...(feature.options ?? []).flatMap((option) => option.links ?? []),
    ]),
  ];
  for (const link of declared) {
    assert.ok(
      html.includes(`href="${linkHref(link)}" target="_blank" rel="noopener noreferrer"`),
      `link ${link.label} is missing from the form`,
    );
  }
});

test("the summaries come from the catalog, so the UI needs no edit to change one", () => {
  assert.equal(CHOICE_GROUPS.length, catalog.groups.length);
  assert.deepEqual(choiceItems("scope").map((item) => item.summary), choiceGroup(catalog, "scope").items.map((item) => item.summary));
});
