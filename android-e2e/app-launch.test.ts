import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { remote } from "webdriverio";

const appiumUrl = new URL(
  process.env.ANDROID_E2E_APPIUM_URL ?? "http://127.0.0.1:4723",
);
const apkPath = process.env.ANDROID_E2E_APK;
const artifactsDir =
  process.env.ANDROID_E2E_ARTIFACTS ?? "android-e2e/artifacts";
let driver: WebdriverIO.Browser | undefined;

function getLogLevel():
  "trace" | "debug" | "info" | "warn" | "error" | "silent" {
  const value = process.env.ANDROID_E2E_WDIO_LOG_LEVEL ?? "warn";
  if (["trace", "debug", "info", "warn", "error", "silent"].includes(value)) {
    return value as ReturnType<typeof getLogLevel>;
  }
  throw new Error(`Unsupported ANDROID_E2E_WDIO_LOG_LEVEL: ${value}`);
}

after(async () => {
  if (driver) await driver.deleteSession();
});

test(
  "the packaged Android app exposes a working Capacitor WebView",
  { timeout: 120_000 },
  async () => {
    assert.ok(apkPath, "ANDROID_E2E_APK must point to the debug APK");

    driver = await remote({
      protocol: appiumUrl.protocol.replace(":", ""),
      hostname: appiumUrl.hostname,
      port: Number(appiumUrl.port),
      path: "/",
      logLevel: getLogLevel(),
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:deviceName": process.env.ANDROID_E2E_DEVICE_NAME ?? "Android",
        ...(process.env.ANDROID_E2E_UDID
          ? { "appium:udid": process.env.ANDROID_E2E_UDID }
          : {}),
        "appium:app": apkPath,
        "appium:appPackage": "co.aiclient.risu",
        "appium:appActivity": ".MainActivity",
        "appium:autoGrantPermissions": true,
        "appium:noReset": false,
        "appium:newCommandTimeout": 120,
        "appium:ensureWebviewsHavePages": true,
      },
    });

    try {
      let webviewContext: string | undefined;
      await driver.waitUntil(
        async () => {
          const contexts = (await driver?.getContexts()) as string[];
          webviewContext = contexts.find((context) =>
            context.startsWith("WEBVIEW_"),
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
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await driver.saveScreenshot(join(artifactsDir, "app-launch-failure.png"));
      throw error;
    }
  },
);
