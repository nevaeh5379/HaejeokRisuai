import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const uiautomator2DriverRoot = dirname(
  nodeRequire.resolve("appium-uiautomator2-driver/package.json"),
);
const appiumSettingsApk = resolve(
  uiautomator2DriverRoot,
  "node_modules/io.appium.settings/apks/settings_apk-debug.apk",
);
const uiautomator2ServerApksDir = resolve(
  uiautomator2DriverRoot,
  "node_modules/appium-uiautomator2-server/apks",
);
const artifactsDir = resolve(projectRoot, "android-e2e/artifacts");
const apkPath = resolve(
  projectRoot,
  process.env.ANDROID_E2E_APK ??
    "android/app/build/outputs/apk/debug/app-debug.apk",
);
const appiumPort = Number(process.env.ANDROID_E2E_APPIUM_PORT ?? 4723);
const appiumHost = "127.0.0.1";
const appiumUrl = `http://${appiumHost}:${appiumPort}`;
const appiumBin = resolve(
  projectRoot,
  `node_modules/.bin/appium${process.platform === "win32" ? ".cmd" : ""}`,
);
const androidAppPackage = "co.aiclient.risu";

function getAdbCommand(): string {
  return androidSdk
    ? resolve(
        androidSdk,
        `platform-tools/adb${process.platform === "win32" ? ".exe" : ""}`,
      )
    : "adb";
}

function getScopedAdbArgs(args: string[]): string[] {
  return process.env.ANDROID_E2E_UDID
    ? ["-s", process.env.ANDROID_E2E_UDID, ...args]
    : args;
}

function detectAndroidSdk(): string | undefined {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;

  const localProperties = resolve(projectRoot, "android/local.properties");
  if (!existsSync(localProperties)) return undefined;
  const sdkDir = readFileSync(localProperties, "utf8").match(
    /^sdk\.dir=(.+)$/m,
  )?.[1];
  return sdkDir?.replace(/\\:/g, ":").replace(/\\\\/g, "\\");
}

function detectJavaHome(): string | undefined {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const java = execFileSync(locator, ["java"], { encoding: "utf8" }).split(
      /\r?\n/,
    )[0];
    return dirname(dirname(realpathSync(java)));
  } catch {
    return undefined;
  }
}

const androidSdk = detectAndroidSdk();
const javaHome = detectJavaHome();
const toolEnv = {
  ...process.env,
  ...(androidSdk
    ? {
        ANDROID_HOME: androidSdk,
        ANDROID_SDK_ROOT: androidSdk,
        PATH: `${resolve(androidSdk, "platform-tools")}${delimiter}${
          process.env.PATH ?? ""
        }`,
      }
    : {}),
  ...(javaHome ? { JAVA_HOME: javaHome } : {}),
};

function run(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function waitForAppium(child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Appium exited before it became ready (code ${child.exitCode})`,
      );
    }
    try {
      const response = await fetch(`${appiumUrl}/status`);
      if (response.ok) return;
    } catch {
      // The server has not bound its socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for Appium at ${appiumUrl}`);
}

async function assertDeviceConnected(): Promise<void> {
  const adb = getAdbCommand();

  let output = "";
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(adb, ["devices"], {
      cwd: projectRoot,
      env: toolEnv,
    });
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(output)),
    );
  });

  const devices = output
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /\tdevice$/.test(line));
  const requestedDevice = process.env.ANDROID_E2E_UDID;
  const hasReadyDevice = requestedDevice
    ? devices.some((line) => line.startsWith(`${requestedDevice}\t`))
    : devices.length > 0;
  if (!hasReadyDevice) {
    throw new Error(
      requestedDevice
        ? `Android device ${requestedDevice} is not ready according to \`adb devices\`.`
        : "No ready Android emulator or USB-debuggable device was found by `adb devices`.",
    );
  }
}

function runAdbSync(args: string[], timeout = 30_000): string {
  return execFileSync(getAdbCommand(), getScopedAdbArgs(args), {
    cwd: projectRoot,
    env: toolEnv,
    encoding: "utf8",
    timeout,
  });
}

function runAdbVisible(args: string[], timeout: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const command = getAdbCommand();
    const scopedArgs = getScopedAdbArgs(args);
    const child = spawn(command, scopedArgs, {
      cwd: projectRoot,
      env: toolEnv,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `${command} ${scopedArgs.join(" ")} timed out after ${timeout}ms`,
        ),
      );
    }, timeout);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function waitForAndroidPackageManager(): Promise<void> {
  runAdbSync(["wait-for-device"], 120_000);
  const deadline = Date.now() + 120_000;
  let lastError = "Android package manager is not ready";

  while (Date.now() < deadline) {
    try {
      const bootCompleted = runAdbSync([
        "shell",
        "getprop",
        "sys.boot_completed",
      ]).trim();
      const packageManager = runAdbSync([
        "shell",
        "pm",
        "path",
        "android",
      ]).trim();
      if (bootCompleted === "1" && packageManager.startsWith("package:")) {
        return;
      }
      lastError = `boot_completed=${bootCompleted || "<empty>"}, pm=${
        packageManager || "<empty>"
      }`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  throw new Error(
    `Timed out waiting for Android package manager: ${lastError}`,
  );
}

function getUiAutomator2ServerApks(): string[] {
  if (!existsSync(appiumSettingsApk)) {
    throw new Error(`Appium Settings APK not found: ${appiumSettingsApk}`);
  }
  if (!existsSync(uiautomator2ServerApksDir)) {
    throw new Error(
      `UiAutomator2 server APK directory not found: ${uiautomator2ServerApksDir}`,
    );
  }

  const serverApks = readdirSync(uiautomator2ServerApksDir)
    .filter((name) => name.endsWith(".apk"))
    .sort()
    .map((name) => resolve(uiautomator2ServerApksDir, name));
  if (serverApks.length === 0) {
    throw new Error(
      `No UiAutomator2 server APKs found in ${uiautomator2ServerApksDir}`,
    );
  }
  return serverApks;
}

async function installAndroidE2ePackages(): Promise<void> {
  await waitForAndroidPackageManager();
  const serverApks = getUiAutomator2ServerApks();

  console.log(
    `[android-e2e] Preinstalling Appium Settings APK: ${appiumSettingsApk}`,
  );
  await runAdbVisible(["install", "-r", "-g", appiumSettingsApk], 300_000);

  const installs = [
    {
      label: "application APK",
      args: ["install", "-r", "-g", apkPath],
    },
    ...serverApks.map((serverApk) => ({
      label: "UiAutomator2 server APK",
      args: ["install", "-r", serverApk],
    })),
  ];
  for (const { label, args } of installs) {
    console.log(`[android-e2e] Preinstalling ${label}: ${args.at(-1)}`);
    await runAdbVisible(args, 300_000);
  }

  const installedPackage = runAdbSync([
    "shell",
    "pm",
    "path",
    androidAppPackage,
  ]).trim();
  if (!installedPackage.startsWith("package:")) {
    throw new Error(
      `Android package ${androidAppPackage} was not installed successfully.`,
    );
  }
}

async function main(): Promise<void> {
  if (!existsSync(appiumBin)) {
    throw new Error(
      "Appium is not installed. Run `pnpm install --frozen-lockfile` first.",
    );
  }
  if (process.argv.includes("--doctor")) {
    await run(appiumBin, ["driver", "doctor", "uiautomator2"], {
      env: toolEnv,
    });
    return;
  }

  await assertDeviceConnected();

  if (process.env.ANDROID_E2E_SKIP_BUILD !== "1") {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    await run(pnpm, ["run", "android:build:debug"], {
      env: {
        ...toolEnv,
        VITE_ANDROID_E2E: "TRUE",
        // The E2E harness exercises a fork build intended for testing and
        // development, so the legal notice gate must not block the app UI.
        VITE_RISU_LEGAL_CONFIGURED: "TRUE",
        VITE_ANDROID_E2E_REMOTE_URL: process.env.ANDROID_E2E_REMOTE_URL ?? "",
        VITE_ANDROID_E2E_REMOTE_PASSWORD:
          process.env.ANDROID_E2E_REMOTE_PASSWORD ?? "",
      },
    });
  }
  if (!existsSync(apkPath)) {
    throw new Error(`Android debug APK not found: ${apkPath}`);
  }
  await installAndroidE2ePackages();

  mkdirSync(artifactsDir, { recursive: true });
  const chromedriverDir = resolve(artifactsDir, "chromedrivers");
  mkdirSync(chromedriverDir, { recursive: true });
  const appiumLog = createWriteStream(resolve(artifactsDir, "appium.log"));
  const appium = spawn(
    appiumBin,
    [
      "--address",
      appiumHost,
      "--port",
      String(appiumPort),
      "--log-timestamp",
      "--allow-insecure",
      "uiautomator2:chromedriver_autodownload",
    ],
    { cwd: projectRoot, env: toolEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  appium.stdout?.pipe(appiumLog);
  appium.stderr?.pipe(appiumLog);

  const stopAppium = () => {
    if (appium.exitCode === null) appium.kill("SIGTERM");
  };
  process.once("SIGINT", stopAppium);
  process.once("SIGTERM", stopAppium);

  try {
    await waitForAppium(appium);
    const testFilter = process.env.ANDROID_E2E_TEST?.trim();
    const tests = readdirSync(resolve(projectRoot, "android-e2e"))
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => !testFilter || name.includes(testFilter))
      .map((name) => resolve(projectRoot, "android-e2e", name));
    if (tests.length === 0)
      throw new Error("No android-e2e/*.test.ts files were found.");

    const tsxBin = resolve(
      projectRoot,
      `node_modules/.bin/tsx${process.platform === "win32" ? ".cmd" : ""}`,
    );
    const testName = process.env.ANDROID_E2E_TEST_NAME?.trim();
    await run(
      tsxBin,
      [
        "--test",
        "--test-concurrency=1",
        ...(testName ? [`--test-name-pattern=${testName}`] : []),
        ...tests,
      ],
      {
        env: {
          ...toolEnv,
          ANDROID_E2E_APPIUM_URL: appiumUrl,
          ANDROID_E2E_ARTIFACTS: artifactsDir,
          ANDROID_E2E_CHROMEDRIVER_DIR: chromedriverDir,
        },
      },
    );
  } finally {
    if (appium.exitCode === null) {
      const appiumExited = new Promise<void>((resolvePromise) => {
        appium.once("exit", () => resolvePromise());
      });
      stopAppium();
      await appiumExited;
    }
    appiumLog.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[android-e2e] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
