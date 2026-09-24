import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildVersion } from "./build-version.mjs";

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const toolingDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(toolingDirectory, "..");
const tauriConfigPath = join(projectRoot, "src-tauri", "tauri.conf.json");

function ensureLinuxDevDesktopEntry() {
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const identifier = tauriConfig.identifier;
  const binaryPath = join(projectRoot, "src-tauri", "target", "debug", "risuai");
  const waylandAppId = basename(binaryPath);

  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const applicationsDirectory = join(dataHome, "applications");
  const desktopPath = join(applicationsDirectory, `${waylandAppId}.desktop`);
  const legacyDesktopPath =
    typeof identifier === "string" && identifier.length > 0
      ? join(applicationsDirectory, `${identifier}.desktop`)
      : null;

  if (legacyDesktopPath && existsSync(legacyDesktopPath)) {
    const legacyEntry = readFileSync(legacyDesktopPath, "utf8");
    if (legacyEntry.includes("X-HaejeokRisuAI-Dev=true")) {
      rmSync(legacyDesktopPath);
    }
  }

  const existing = existsSync(desktopPath)
    ? readFileSync(desktopPath, "utf8")
    : null;

  // Never overwrite a real installed application entry. This helper only owns
  // the hidden entry it creates for `tauri dev` so KWin can resolve the actual
  // Wayland app-id (`risuai`) to RisuAI's icon.
  if (existing !== null && !existing.includes("X-HaejeokRisuAI-Dev=true")) {
    return;
  }

  const iconPath = join(projectRoot, "src-tauri", "icons", "icon.png");
  const desktopEntry = `[Desktop Entry]\nType=Application\nName=RisuAI\nExec=\"${binaryPath}\"\nIcon=${iconPath}\nTerminal=false\nNoDisplay=true\nStartupWMClass=${waylandAppId}\nX-HaejeokRisuAI-Dev=true\n`;

  if (existing !== desktopEntry) {
    mkdirSync(applicationsDirectory, { recursive: true });
    writeFileSync(desktopPath, desktopEntry);
  }

  if ((process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("kde")) {
    spawnSync("kbuildsycoca6", [], {
      stdio: "ignore",
      env: process.env,
    });
  }

  console.log(`[HaejeokRisuAI] Linux dev desktop entry: ${desktopPath}`);
}

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
  ensureLinuxDevDesktopEntry();
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
