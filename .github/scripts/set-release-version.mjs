import fs from "node:fs";

const buildNumber = process.argv[2];
const subVersion = process.argv[3] ?? "";

if (!buildNumber || !/^\d+$/.test(buildNumber) || !/^[0-9A-Za-z.-]*$/.test(subVersion)) {
  console.error("Usage: node .github/scripts/set-release-version.mjs <build-number> [sub-version]");
  process.exit(1);
}

const buildTag = `b${buildNumber}`;
const semver = `0.0.${buildNumber}`;

const versionPath = "version.json";
const versionJson = JSON.parse(fs.readFileSync(versionPath, "utf8"));
versionJson.version = buildTag;
fs.writeFileSync(versionPath, `${JSON.stringify(versionJson, null, 2)}\n`);

const tauriPath = "src-tauri/tauri.conf.json";
const tauriConfig = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
tauriConfig.version = semver;
fs.writeFileSync(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
const databasePath = "src/ts/storage/database.svelte.ts";
let databaseSource = fs.readFileSync(databasePath, "utf8");

const versionPattern = /export let appVer = "[^"]+"; \/\/<APP_VERSION_POINT>/;
const subVersionPattern = /export let appSubVer = "[^"]*";/;

if (!versionPattern.test(databaseSource) || !subVersionPattern.test(databaseSource)) {
  console.error("Could not find RisuAI version markers in database.svelte.ts");
  process.exit(1);
}

databaseSource = databaseSource
  .replace(versionPattern, `export let appVer = "${buildTag}"; //<APP_VERSION_POINT>`)
  .replace(subVersionPattern, `export let appSubVer = "${subVersion}";`);

fs.writeFileSync(databasePath, databaseSource);

console.log(`Release version: ${buildTag}`);
console.log(`Tauri version: ${semver}`);
