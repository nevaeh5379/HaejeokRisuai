import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { remote } from "webdriverio";
import {
  getAndroidE2eConnectionRetryTimeout,
  getAndroidE2eInfrastructureCapabilities,
  getAndroidE2eTestTimeout,
} from "./appium-capabilities";

const appiumUrl = new URL(
  process.env.ANDROID_E2E_APPIUM_URL ?? "http://127.0.0.1:4723",
);
const apkPath = process.env.ANDROID_E2E_APK;
const artifactsDir =
  process.env.ANDROID_E2E_ARTIFACTS ?? "android-e2e/artifacts";
const chromedriverDir =
  process.env.ANDROID_E2E_CHROMEDRIVER_DIR ??
  join(artifactsDir, "chromedrivers");
let driver: WebdriverIO.Browser | undefined;

function getLogLevel():
  "trace" | "debug" | "info" | "warn" | "error" | "silent" {
  const value = process.env.ANDROID_E2E_WDIO_LOG_LEVEL ?? "warn";
  if (["trace", "debug", "info", "warn", "error", "silent"].includes(value)) {
    return value as ReturnType<typeof getLogLevel>;
  }
  throw new Error(`Unsupported ANDROID_E2E_WDIO_LOG_LEVEL: ${value}`);
}

function readWindowDump(): string {
  const args = process.env.ANDROID_E2E_UDID
    ? ["-s", process.env.ANDROID_E2E_UDID, "shell", "dumpsys", "window"]
    : ["shell", "dumpsys", "window"];
  return execFileSync("adb", args, { encoding: "utf8" });
}

after(async () => {
  if (driver) await driver.deleteSession();
});

test(
  "the packaged Android app exposes a working Capacitor WebView",
  { timeout: getAndroidE2eTestTimeout(120_000) },
  async () => {
    assert.ok(apkPath, "ANDROID_E2E_APK must point to the debug APK");
    await mkdir(chromedriverDir, { recursive: true });

    driver = await remote({
      protocol: appiumUrl.protocol.replace(":", ""),
      hostname: appiumUrl.hostname,
      port: Number(appiumUrl.port),
      path: "/",
      logLevel: getLogLevel(),
      connectionRetryTimeout: getAndroidE2eConnectionRetryTimeout(),
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        ...getAndroidE2eInfrastructureCapabilities(),
        "appium:deviceName": process.env.ANDROID_E2E_DEVICE_NAME ?? "Android",
        ...(process.env.ANDROID_E2E_UDID
          ? { "appium:udid": process.env.ANDROID_E2E_UDID }
          : {}),
        "appium:app": apkPath,
        "appium:appPackage": "co.aiclient.risu",
        "appium:appActivity": ".MainActivity",
        "appium:enforceAppInstall": true,
        "appium:autoGrantPermissions": true,
        "appium:noReset": false,
        "appium:newCommandTimeout": 120,
        "appium:ensureWebviewsHavePages": true,
        "appium:chromedriverExecutableDir": chromedriverDir,
      },
    });

    try {
      let webviewContext: string | undefined;
      await driver.waitUntil(
        async () => {
          const contexts = (await driver?.getContexts()) as string[];
          webviewContext =
            contexts.find(
              (context) => context === "WEBVIEW_co.aiclient.risu",
            ) ??
            contexts.find(
              (context) =>
                context.startsWith("WEBVIEW_") && context !== "WEBVIEW_chrome",
            );
          return Boolean(webviewContext);
        },
        {
          timeout: 30_000,
          interval: 500,
          timeoutMsg: "Capacitor WebView context did not appear",
        },
      );
      assert.ok(webviewContext);
      await driver.switchContext(webviewContext);

      await driver.waitUntil(
        async () => driver?.execute(() => document.readyState === "complete"),
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg: "Capacitor document did not finish loading",
        },
      );

      const state = await driver.execute(() => {
        const runtime = globalThis as typeof globalThis & {
          Capacitor?: { isNativePlatform?: () => boolean };
        };
        return {
          bodyText: document.body?.innerText ?? "",
          href: location.href,
          isNative: Boolean(runtime.Capacitor?.isNativePlatform?.()),
        };
      });

      assert.equal(
        state.isNative,
        true,
        "Capacitor did not report a native platform",
      );
      assert.match(state.href, /^https:\/\/localhost(?:\/|$)/);
      assert.ok(
        state.bodyText.trim().length > 0,
        "The packaged app rendered an empty document",
      );
      assert.doesNotMatch(state.bodyText, /Legal documents not configured/i);

      // Immersive status-bar handling belongs to the Android shell itself,
      // not to any particular web UI theme.
      await driver.waitUntil(
        async () => /type=statusBars[^\n]*visible=false/.test(readWindowDump()),
        {
          timeout: 5_000,
          interval: 250,
          timeoutMsg: "Android status bar stayed visible",
        },
      );

      await driver.waitUntil(
        async () =>
          driver?.execute(() => {
            const root = document.documentElement;
            const accent = getComputedStyle(root)
              .getPropertyValue("--risu-android-system-accent")
              .trim();
            return (
              root.classList.contains("theme-android-material") &&
              accent.length > 0
            );
          }),
        {
          timeout: 15_000,
          interval: 250,
          timeoutMsg:
            "Android Material theme or dynamic palette was not applied",
        },
      );

      const materialState = await driver.execute(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          accent: style.getPropertyValue("--risu-android-system-accent").trim(),
          surface: style
            .getPropertyValue("--risu-android-system-surface")
            .trim(),
          background: style.getPropertyValue("--risu-theme-bgcolor").trim(),
        };
      });
      assert.match(materialState.accent, /^#[0-9a-f]{6}$/i);
      assert.match(materialState.surface, /^#[0-9a-f]{6}$/i);
      assert.equal(materialState.background, materialState.surface);
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await driver.saveScreenshot(join(artifactsDir, "app-launch-failure.png"));
      throw error;
    }
  },
);
