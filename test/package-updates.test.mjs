import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareCatalogToCli, compareVersions, experimentalFeatureIds, helpGroupHeadings, renderReport, unknownHelpHeadings } from "../scripts/check-package-updates.mjs";

/** The three toggle groups the pinned CLI prints, in the layout check-package-updates parses. */
const CLI_HELP = [
  "Usage: maronn-oidc <command> <framework> [options]",
  "",
  "Options:",
  "  --enable <features>   Comma-separated features to enable (repeatable)",
  "",
  "Features (all enabled by default): pkce, refresh-token",
  "",
  "Optional features (disabled by default): transaction-binding",
  "  Stable hardening that no OIDC Core / OAuth 2.1 clause requires.",
  "",
  "Experimental features (disabled by default): par, token-exchange",
  "  Provided by the separate @maronn-openid-connect/experimental package.",
].join("\n");

test("version comparison orders releases above their prereleases", () => {
  assert.ok(compareVersions("0.0.2", "0.0.1") > 0);
  assert.ok(compareVersions("0.1.0", "0.0.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.0.1", "0.0.1"), 0);
  assert.ok(compareVersions("0.0.1", "0.0.2") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-rc.2") < 0);
  // semver §11: numeric identifiers compare numerically, so rc.10 is newer than rc.9.
  assert.ok(compareVersions("0.1.0-rc.10", "0.1.0-rc.9") > 0);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-1") > 0);
});

test("experimental feature ids come from the published subpath exports", () => {
  const result = experimentalFeatureIds({
    exports: {
      ".": {},
      "./package.json": {},
      "./par": { import: "./dist/par/index.js" },
      "./dpop": { import: "./dist/dpop/index.js" },
      "./Not_An_Id": {},
    },
  });
  assert.deepEqual(result.ids, ["par", "dpop"]);
  assert.deepEqual(result.unsupportedSubpaths, ["./Not_An_Id"]);
  assert.deepEqual(experimentalFeatureIds({}).ids, []);
  // A root-only exports map keys on conditions, not subpaths; none of them are features.
  assert.deepEqual(experimentalFeatureIds({ exports: { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" } }).ids, []);
});

test("every toggle group the help text prints is either parsed or reported as unknown", () => {
  assert.deepEqual(helpGroupHeadings(CLI_HELP), [
    "Features (all enabled by default)",
    "Optional features (disabled by default)",
    "Experimental features (disabled by default)",
  ]);
  assert.deepEqual(unknownHelpHeadings(CLI_HELP), []);
  // The failure this guards against: the CLI grew "Optional features" as a third group and
  // the report said nothing, because a group nobody parses looks exactly like no group.
  const withNewGroup = `${CLI_HELP}\n\nHardened features (disabled by default): mtls\n`;
  assert.deepEqual(unknownHelpHeadings(withNewGroup), ["Hardened features (disabled by default)"]);
});

test("a catalog is compared against the ids the CLI says it can generate", () => {
  const catalog = { features: [{ id: "transaction-binding", status: "supported" }, { id: "old-thing", status: "detected" }] };
  const result = compareCatalogToCli(catalog, ["transaction-binding", "mtls"]);
  assert.deepEqual(result.published, ["transaction-binding", "mtls"]);
  assert.deepEqual(result.added, ["mtls"]);
  assert.deepEqual(result.unwired, ["old-thing"]);
  assert.deepEqual(result.ungeneratable, []);
  // A `supported` entry the CLI dropped is offered by the portal but cannot be generated.
  assert.deepEqual(compareCatalogToCli(catalog, []).ungeneratable, ["transaction-binding"]);
});

test("the report calls out new, removed, and unwired features in both opt-in groups", () => {
  const markdown = renderReport({
    checkedAt: "2026-08-03T00:00:00.000Z",
    packages: [{ name: "@maronn-openid-connect/experimental", pinned: "0.0.1", latest: "0.1.0", hasUpdate: true }],
    experimental: { latest: "0.1.0", published: ["par", "dpop"], added: ["dpop"], removed: ["rar"], unwired: ["dpop"], unsupportedSubpaths: [] },
    optional: { published: ["transaction-binding", "mtls"], added: ["mtls"], removed: ["retired-thing"], unwired: ["mtls"], ungeneratable: [] },
    cli: { latest: "0.1.0", features: ["pkce"], optional: ["transaction-binding"], experimental: ["par"], added: ["pkce-plus"], removed: [], ungeneratable: ["dpop"], unknownSections: ["Hardened features (disabled by default)"] },
    hasUpdates: true,
    hasCatalogWork: true,
  });
  assert.match(markdown, /新機能: `dpop`/);
  assert.match(markdown, /削除された機能: `rar`/);
  assert.match(markdown, /未配線のまま残っている機能: `dpop`/);
  assert.match(markdown, /未対応のトグル: `pkce-plus`/);
  assert.match(markdown, /CLIが生成できないカタログ項目: `dpop`/);
  assert.match(markdown, /最新CLIのexperimentalトグル: `par`/);
  assert.match(markdown, /docs\/experimental\.md/);

  assert.match(markdown, /### オプション機能/);
  assert.match(markdown, /新機能: `mtls`/);
  assert.match(markdown, /削除された機能: `retired-thing`/);
  assert.match(markdown, /最新CLIのoptionalトグル: `transaction-binding`/);
  assert.match(markdown, /docs\/optional-features\.md/);
  assert.match(markdown, /未知のトグル分類: `Hardened features \(disabled by default\)`/);
});

test("the report says so when the optional group could not be inspected", () => {
  const markdown = renderReport({
    checkedAt: "2026-08-03T00:00:00.000Z",
    packages: [],
    experimental: { latest: "0.1.0", published: ["par"], added: [], removed: [], unwired: [], unsupportedSubpaths: [] },
    // --skip-cli-features: --help is the only source for this group, so there is nothing to say.
    optional: null,
    cli: { latest: "0.1.0", features: null, optional: null, experimental: null, added: [], removed: [], ungeneratable: [], unknownSections: [] },
    hasUpdates: false,
    hasCatalogWork: false,
  });
  assert.match(markdown, /--skip-cli-features/);
});

test("the tracked packages stay pinned to exact versions", async () => {
  const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
  for (const [key, name] of [["maronnOidcCli", "@maronn-openid-connect/cli"], ["maronnOidcCore", "@maronn-openid-connect/core"], ["maronnOidcExperimental", "@maronn-openid-connect/experimental"]]) {
    assert.match(rootPackage.config[key], new RegExp(`^${name}@\\d+\\.\\d+\\.\\d+$`));
  }
  assert.match(rootPackage.dependencies["@maronn-openid-connect/experimental"], /^\d+\.\d+\.\d+$/);
  assert.equal(rootPackage.scripts["packages:check"], "node scripts/check-package-updates.mjs");
  assert.equal(rootPackage.scripts["packages:update"], "node scripts/check-package-updates.mjs --apply");
});

test("both opt-in catalogs stay readable and mutually exclusive", async () => {
  const [optional, experimental] = await Promise.all([
    readFile("optional-features.json", "utf8").then(JSON.parse),
    readFile("experimental-features.json", "utf8").then(JSON.parse),
  ]);
  const optionalIds = optional.features.map((feature) => feature.id);
  const experimentalIds = experimental.features.map((feature) => feature.id);
  // Both groups feed one --enable list, so an id in both would be ambiguous to wire.
  assert.deepEqual(optionalIds.filter((id) => experimentalIds.includes(id)), []);
});
