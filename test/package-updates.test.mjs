import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareVersions, experimentalFeatureIds, renderReport } from "../scripts/check-package-updates.mjs";

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

test("the report calls out new, removed, and unwired experimental features", () => {
  const markdown = renderReport({
    checkedAt: "2026-08-03T00:00:00.000Z",
    packages: [{ name: "@maronn-oidc/experimental", pinned: "0.0.1", latest: "0.1.0", hasUpdate: true }],
    experimental: { latest: "0.1.0", published: ["par", "dpop"], added: ["dpop"], removed: ["rar"], unwired: ["dpop"], unsupportedSubpaths: [] },
    cli: { latest: "0.1.0", features: ["pkce", "par"], added: ["par"], removed: [] },
    hasUpdates: true,
    hasCatalogWork: true,
  });
  assert.match(markdown, /新機能: `dpop`/);
  assert.match(markdown, /削除された機能: `rar`/);
  assert.match(markdown, /未配線のまま残っている機能: `dpop`/);
  assert.match(markdown, /未対応のトグル: `par`/);
  assert.match(markdown, /docs\/experimental\.md/);
});

test("the tracked packages stay pinned to exact versions", async () => {
  const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
  for (const [key, name] of [["maronnOidcCli", "@maronn-oidc/cli"], ["maronnOidcCore", "@maronn-oidc/core"], ["maronnOidcExperimental", "@maronn-oidc/experimental"]]) {
    assert.match(rootPackage.config[key], new RegExp(`^${name}@\\d+\\.\\d+\\.\\d+$`));
  }
  assert.match(rootPackage.dependencies["@maronn-oidc/experimental"], /^\d+\.\d+\.\d+$/);
  assert.equal(rootPackage.scripts["packages:check"], "node scripts/check-package-updates.mjs");
  assert.equal(rootPackage.scripts["packages:update"], "node scripts/check-package-updates.mjs --apply");
});
