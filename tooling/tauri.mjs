import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveBuildVersion } from "./build-version.mjs";

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const version = resolveBuildVersion();
const args = process.argv.slice(2);
const command = args[0];
const needsVersionConfig = command === "build" || command === "dev";

if (needsVersionConfig) {
  args.push(
    "--config",
    JSON.stringify({
      version: version.tauriVersion,
    }),
  );
}

console.log(
  `[HaejeokRisuAI] ${version.buildTag} (${version.source}), Tauri ${version.tauriVersion}`,
);

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(version.buildNumber === null
      ? {}
      : { HAEJEOK_BUILD_NUMBER: String(version.buildNumber) }),
  },
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
