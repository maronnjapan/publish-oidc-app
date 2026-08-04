#!/usr/bin/env node

// Follows @maronn-openid-connect/cli, @maronn-openid-connect/core and @maronn-openid-connect/experimental releases.
//
//   node scripts/check-package-updates.mjs             report only (exit 0)
//   node scripts/check-package-updates.mjs --apply      also bump the pins and the catalog
//   node scripts/check-package-updates.mjs --report r.md write the markdown report to a file
//
// Reporting covers three questions:
//   1. is a newer version published?
//   2. does @maronn-openid-connect/experimental export a feature the catalog does not know about?
//   3. did the CLI's own feature toggles change?
// Newly discovered experimental features are recorded as status "detected"; wiring them
// up so the portal can offer them is a code change described in docs/experimental.md.

import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { EXPERIMENTAL_CATALOG_PATH, ROOT, readExperimentalCatalog } from "./lib.mjs";

const execFile = promisify(execFileCallback);
const REGISTRY = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

const TRACKED_PACKAGES = [
  { name: "@maronn-openid-connect/cli", configKey: "maronnOidcCli", dependencyField: "devDependencies" },
  { name: "@maronn-openid-connect/core", configKey: "maronnOidcCore", dependencyField: "dependencies" },
  { name: "@maronn-openid-connect/experimental", configKey: "maronnOidcExperimental", dependencyField: "dependencies" },
];

/** Feature toggles the generator and the portal currently understand. */
const KNOWN_CLI_FEATURES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"];

function splitVersion(version) {
  const [core, prerelease = ""] = version.split(/-(.*)/s);
  const numbers = core.split(".").map((part) => Number.parseInt(part, 10));
  return { numbers: [numbers[0] || 0, numbers[1] || 0, numbers[2] || 0], prerelease };
}

/** semver §11: numeric prerelease identifiers compare numerically, so rc.10 > rc.9. */
function comparePrerelease(left, right) {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumeric = /^\d+$/.test(a[index]);
    const bNumeric = /^\d+$/.test(b[index]);
    if (aNumeric && bNumeric) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference !== 0) return difference;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

/** Returns > 0 when `left` is newer than `right`. Prereleases sort below their release. */
export function compareVersions(left, right) {
  const a = splitVersion(left);
  const b = splitVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function pinnedVersion(specifier, name) {
  if (typeof specifier !== "string") return null;
  const prefix = `${name}@`;
  return specifier.startsWith(prefix) ? specifier.slice(prefix.length) : null;
}

async function registryJson(pathSuffix, accept) {
  const response = await fetch(`${REGISTRY}/${pathSuffix}`, { headers: { accept } });
  if (!response.ok) throw new Error(`npm registry request failed for ${pathSuffix}: HTTP ${response.status}`);
  return response.json();
}

function encodePackageName(name) {
  return name.replace("/", "%2f");
}

async function fetchPackument(name) {
  // The abbreviated document is enough for dist-tags and keeps the response small.
  return registryJson(encodePackageName(name), "application/vnd.npm.install-v1+json, application/json");
}

async function fetchVersionManifest(name, version) {
  // Only the full per-version manifest carries `exports`, which is how experimental
  // features are published.
  return registryJson(`${encodePackageName(name)}/${encodeURIComponent(version)}`, "application/json");
}

/** Feature ids are the subpath exports of @maronn-openid-connect/experimental (`./par` -> `par`). */
export function experimentalFeatureIds(packageManifest) {
  const exportsMap = packageManifest?.exports;
  if (!exportsMap || typeof exportsMap !== "object") return { ids: [], unsupportedSubpaths: [] };
  const ids = [];
  const unsupportedSubpaths = [];
  for (const subpath of Object.keys(exportsMap)) {
    // A root-only exports map uses condition names ("types", "import") as its keys;
    // only entries that are actually subpaths can be feature ids.
    if (!subpath.startsWith("./") || subpath === "./package.json") continue;
    const id = subpath.slice(2);
    if (FEATURE_ID_PATTERN.test(id)) ids.push(id);
    else unsupportedSubpaths.push(subpath);
  }
  return { ids, unsupportedSubpaths };
}

function parseFeatureList(line) {
  return line.split(",").map((feature) => feature.trim()).filter(Boolean);
}

/**
 * The CLI prints both toggle lists in --help, which is the only published surface for
 * them. The experimental list is what gates whether a catalog entry can be generated at
 * all, so a catalog id the CLI does not know is worth reporting.
 */
async function cliFeatures(version) {
  try {
    const { stdout } = await execFile(
      "npm",
      ["exec", "--yes", `--package=@maronn-openid-connect/cli@${version}`, "--", "maronn-oidc", "--help"],
      { cwd: ROOT, maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
    );
    const standard = stdout.match(/Features \(all enabled by default\):\s*(.+)/);
    if (!standard) return null;
    const experimental = stdout.match(/Experimental features \(disabled by default\):\s*(.+)/);
    return {
      features: parseFeatureList(standard[1]),
      experimental: experimental ? parseFeatureList(experimental[1]) : [],
    };
  } catch {
    return null;
  }
}

export async function collectReport({ inspectCliFeatures = true } = {}) {
  const rootPackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const catalog = await readExperimentalCatalog();
  const packages = [];
  let experimentalManifest = null;

  for (const tracked of TRACKED_PACKAGES) {
    const pinned = pinnedVersion(rootPackage.config?.[tracked.configKey], tracked.name);
    if (!pinned) throw new Error(`package.json config.${tracked.configKey} must pin ${tracked.name}@<version>`);
    const packument = await fetchPackument(tracked.name);
    const latest = packument["dist-tags"]?.latest;
    if (typeof latest !== "string") throw new Error(`${tracked.name} has no dist-tags.latest`);
    if (tracked.name === "@maronn-openid-connect/experimental") {
      experimentalManifest = packument.versions?.[latest]?.exports
        ? packument.versions[latest]
        : await fetchVersionManifest(tracked.name, latest);
    }
    packages.push({
      ...tracked,
      pinned,
      latest,
      hasUpdate: compareVersions(latest, pinned) > 0,
      dependencyPinned: rootPackage[tracked.dependencyField]?.[tracked.name] ?? null,
    });
  }

  const experimentalPackage = packages.find((entry) => entry.name === "@maronn-openid-connect/experimental");
  const { ids: publishedFeatureIds, unsupportedSubpaths } = experimentalFeatureIds(experimentalManifest);
  const catalogIds = catalog.features.map((feature) => feature.id);
  const experimental = {
    latest: experimentalPackage.latest,
    published: publishedFeatureIds,
    added: publishedFeatureIds.filter((id) => !catalogIds.includes(id)),
    removed: publishedFeatureIds.length > 0 ? catalogIds.filter((id) => !publishedFeatureIds.includes(id)) : [],
    unwired: catalog.features.filter((feature) => feature.status === "detected").map((feature) => feature.id),
    unsupportedSubpaths,
  };

  const cliPackage = packages.find((entry) => entry.name === "@maronn-openid-connect/cli");
  const toggles = inspectCliFeatures ? await cliFeatures(cliPackage.latest) : null;
  const cli = {
    latest: cliPackage.latest,
    features: toggles?.features ?? null,
    experimental: toggles?.experimental ?? null,
    added: toggles ? toggles.features.filter((feature) => !KNOWN_CLI_FEATURES.includes(feature)) : [],
    removed: toggles ? KNOWN_CLI_FEATURES.filter((feature) => !toggles.features.includes(feature)) : [],
    // A catalog entry the CLI cannot generate is unusable, whatever the package exports.
    ungeneratable: toggles ? catalog.features.filter((feature) => feature.status === "supported" && !toggles.experimental.includes(feature.id)).map((feature) => feature.id) : [],
  };

  return {
    checkedAt: new Date().toISOString(),
    packages,
    experimental,
    cli,
    hasUpdates: packages.some((entry) => entry.hasUpdate),
    hasCatalogWork: experimental.added.length > 0 || experimental.removed.length > 0 || cli.added.length > 0 || cli.removed.length > 0 || cli.ungeneratable.length > 0,
  };
}

export function renderReport(report) {
  const lines = ["## @maronn-openid-connect パッケージ追従レポート", "", `検査時刻: ${report.checkedAt}`, "", "| パッケージ | 固定中 | 最新 | 状態 |", "|---|---|---|---|"];
  for (const entry of report.packages) {
    lines.push(`| \`${entry.name}\` | ${entry.pinned} | ${entry.latest} | ${entry.hasUpdate ? "**更新あり**" : "最新"} |`);
  }
  lines.push("");

  lines.push("### experimental 機能");
  if (report.experimental.published.length === 0) {
    lines.push("- 公開されている subpath export を取得できませんでした（レジストリの `exports` が読めない可能性があります）。");
  } else {
    lines.push(`- 公開中: ${report.experimental.published.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (report.experimental.added.length > 0) {
    lines.push(`- **新機能: ${report.experimental.added.map((id) => `\`${id}\``).join(", ")}** — \`npm run packages:update\` でカタログに \`status: "detected"\` として追記されます。ポータルで選択できるようにするには \`docs/experimental.md\` の配線手順が必要です。`);
  }
  if (report.experimental.removed.length > 0) {
    lines.push(`- **削除された機能: ${report.experimental.removed.map((id) => `\`${id}\``).join(", ")}** — core へ昇格したか取り下げられています。カタログと生成コードから外してください。`);
  }
  if (report.experimental.unwired.length > 0) {
    lines.push(`- 未配線のまま残っている機能: ${report.experimental.unwired.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (report.experimental.unsupportedSubpaths.length > 0) {
    lines.push(`- 機能IDとして扱えない subpath: ${report.experimental.unsupportedSubpaths.map((value) => `\`${value}\``).join(", ")}`);
  }
  lines.push("");

  lines.push("### CLI 機能トグル");
  if (!report.cli.features) {
    lines.push("- `maronn-oidc --help` からトグル一覧を取得できませんでした。手動で確認してください。");
  } else {
    lines.push(`- 最新CLIのトグル: ${report.cli.features.map((feature) => `\`${feature}\``).join(", ")}`);
    lines.push(`- 最新CLIのexperimentalトグル: ${(report.cli.experimental ?? []).map((feature) => `\`${feature}\``).join(", ") || "（なし）"}`);
    if (report.cli.added.length > 0) lines.push(`- **未対応のトグル: ${report.cli.added.map((feature) => `\`${feature}\``).join(", ")}** — ポータルの \`FEATURE_NAMES\` と生成/デプロイの \`FEATURES\` に追加してください。`);
    if (report.cli.removed.length > 0) lines.push(`- **廃止されたトグル: ${report.cli.removed.map((feature) => `\`${feature}\``).join(", ")}** — 参照を削除してください。`);
    if (report.cli.ungeneratable.length > 0) lines.push(`- **CLIが生成できないカタログ項目: ${report.cli.ungeneratable.map((feature) => `\`${feature}\``).join(", ")}** — カタログでは supported ですが最新CLIの \`--enable\` が受け付けません。カタログを \`detected\` へ戻すか、CLIの更新を待ってください。`);
  }
  lines.push("");
  lines.push("バージョンを上げたら `npm run check` を実行してください。`test/experimental.test.mjs` が各experimental機能を実際に生成・バンドルして検証します。");
  return `${lines.join("\n")}\n`;
}

function catalogEntryForDetectedFeature(id, version) {
  return {
    id,
    status: "detected",
    subpath: `@maronn-openid-connect/experimental/${id}`,
    label: `${id}（未配線）`,
    spec: "",
    summary: `@maronn-openid-connect/experimental@${version} が公開した新機能です。docs/experimental.md の手順で配線するとポータルで選択できるようになります。`,
    endpoints: [],
    detected_version: version,
  };
}

export async function applyUpdates(report) {
  const applied = [];
  const packagePath = path.join(ROOT, "package.json");
  const rootPackage = JSON.parse(await readFile(packagePath, "utf8"));
  for (const entry of report.packages) {
    if (!entry.hasUpdate) continue;
    rootPackage.config[entry.configKey] = `${entry.name}@${entry.latest}`;
    if (rootPackage[entry.dependencyField]?.[entry.name] !== undefined) {
      rootPackage[entry.dependencyField][entry.name] = entry.latest;
    }
    applied.push(`${entry.name} ${entry.pinned} -> ${entry.latest}`);
  }
  if (applied.length > 0) {
    await writeFile(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  }

  if (report.experimental.added.length > 0) {
    const catalog = JSON.parse(await readFile(EXPERIMENTAL_CATALOG_PATH, "utf8"));
    for (const id of report.experimental.added) {
      catalog.features.push(catalogEntryForDetectedFeature(id, report.experimental.latest));
      applied.push(`experimental-features.json += ${id} (status: detected)`);
    }
    await writeFile(EXPERIMENTAL_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  if (applied.length > 0) {
    await execFile("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
  }
  return applied;
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const reportIndex = argv.indexOf("--report");
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;
  const report = await collectReport({ inspectCliFeatures: !argv.includes("--skip-cli-features") });
  const markdown = renderReport(report);
  process.stdout.write(markdown);

  if (reportPath) await writeFile(path.resolve(reportPath), markdown);
  if (apply) {
    const applied = await applyUpdates(report);
    process.stdout.write(applied.length > 0 ? `\n適用しました:\n${applied.map((line) => `- ${line}`).join("\n")}\n` : "\n適用する変更はありません。\n");
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_OUTPUT, [
      `has_updates=${report.hasUpdates}`,
      `has_catalog_work=${report.hasCatalogWork}`,
      `needs_attention=${report.hasUpdates || report.hasCatalogWork}`,
      "",
    ].join("\n"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
