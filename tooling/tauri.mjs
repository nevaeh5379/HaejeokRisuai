import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveBuildVersion } from "./build-version.mjs";

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const version = resolveBuildVersion();
const args = process.argv.slice(2);
const command = args[0];
const needsVersionConfig = command === "build" || command === "dev";
const hasUpdaterSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const tauriEnvironment = {
  ...process.env,
  ...(version.buildNumber === null
    ? {}
    : { HAEJEOK_BUILD_NUMBER: String(version.buildNumber) }),
};

if (process.platform === "linux" && command === "build") {
  // linuxdeploy bundles an older strip that cannot read Arch Linux RELR sections.
  tauriEnvironment.NO_STRIP ??= "1";
}

if (
  process.platform === "linux" &&
  command === "dev" &&
  (process.env.XDG_SESSION_TYPE === "wayland" ||
    process.env.GDK_BACKEND === "wayland")
) {
  // WebKitGTK's DMABUF renderer can terminate the web process on Wayland.
  tauriEnvironment.WEBKIT_DISABLE_DMABUF_RENDERER ??= "1";
}

if (needsVersionConfig) {
  const config = {
    version: version.tauriVersion,
    ...(command === "build" && !hasUpdaterSigningKey
      ? { bundle: { createUpdaterArtifacts: false } }
      : {}),
  };

  args.push(
    "--config",
    JSON.stringify(config),
  );
}

console.log(
  `[HaejeokRisuAI] ${version.buildTag} (${version.source}), Tauri ${version.tauriVersion}`,
);

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  stdio: "inherit",
  env: tauriEnvironment,
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
