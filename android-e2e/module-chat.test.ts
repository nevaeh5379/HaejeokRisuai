import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { remote } from "webdriverio";
import {
  getAndroidE2eConnectionRetryTimeout,
  getAndroidE2eInfrastructureCapabilities,
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

after(async () => {
  if (driver) await driver.deleteSession();
});

test(
  "a persisted Android chat applies its module and opens the module menu",
  { timeout: 360_000 },
  async () => {
    assert.ok(apkPath, "ANDROID_E2E_APK must point to the debug APK");
    await mkdir(chromedriverDir, { recursive: true });

    driver = await remote({
      protocol: appiumUrl.protocol.replace(":", ""),
      hostname: appiumUrl.hostname,
      port: Number(appiumUrl.port),
      path: "/",
      logLevel: "warn",
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
        async () => {
          try {
            return await driver?.execute(
              () =>
                localStorage.getItem(
                  "risu_android_e2e_module_rendering_fixture_ready_v5",
                ) === "true" &&
                document.body.innerText.includes(
                  "Android E2E Module Rendering Character",
                ),
            );
          } catch {
            await driver?.switchContext("NATIVE_APP").catch(() => undefined);
            const contexts = (await driver?.getContexts().catch(() => [])) as
              string[] | undefined;
            const liveWebview =
              contexts?.find(
                (context) => context === "WEBVIEW_co.aiclient.risu",
              ) ??
              contexts?.find(
                (context) =>
                  context.startsWith("WEBVIEW_") &&
                  context !== "WEBVIEW_chrome",
              );
            if (liveWebview) {
              await driver?.switchContext(liveWebview).catch(() => undefined);
            }
            return false;
          }
        },
        {
          timeout: 90_000,
          interval: 500,
          timeoutMsg: "The persisted character list did not become ready",
        },
      );

      const openedCharacter = await driver.execute(() => {
        const name = "Android E2E Module Rendering Character";
        const label = [...document.querySelectorAll<HTMLElement>("*")].find(
          (element) =>
            element.children.length === 0 &&
            element.textContent?.trim() === name &&
            element.getClientRects().length > 0,
        );
        const card = label?.closest<HTMLElement>(
          '[role="button"], button, .cursor-pointer',
        );
        card?.click();
        return Boolean(card);
      });
      assert.equal(
        openedCharacter,
        true,
        "The persisted character card was not clickable",
      );

      await driver.waitUntil(
        async () =>
          driver?.execute(() =>
            Boolean(
              document.querySelector(
                'button[risu-btn="android-e2e-module-action"]',
              ),
            ),
          ),
        {
          timeout: 90_000,
          interval: 500,
          timeoutMsg: "Persisted module action did not appear in the chat",
        },
      );

      await driver.waitUntil(
        async () =>
          driver?.execute(() =>
            Boolean(document.querySelector("#android-e2e-prompt-render")),
          ),
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg:
            "The prompt-selected module did not render its CBS/HTML/CSS",
        },
      );
      const promptRendering = await driver.execute(() => {
        const rendered = document.querySelector<HTMLElement>(
          "#android-e2e-prompt-render",
        );
        return {
          text: rendered?.textContent?.trim(),
          color: rendered ? getComputedStyle(rendered).color : undefined,
        };
      });
      assert.deepEqual(promptRendering, {
        text: "android prompt cbs: Android E2E Module Rendering Character",
        color: "rgb(1, 2, 3)",
      });

      await driver.waitUntil(
        async () =>
          driver?.execute(() => {
            if (
              document.body.innerText.includes("android module button worked")
            ) {
              return true;
            }
            document
              .querySelector<HTMLButtonElement>(
                'button[risu-btn="android-e2e-module-action"]',
              )
              ?.click();
            return document.body.innerText.includes(
              "android module button worked",
            );
          }),
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg: "The persisted chat module did not handle its button",
        },
      );

      const chatMenuButton = await driver.$(".rs-chat-menu-btn");
      await chatMenuButton.waitForDisplayed({ timeout: 15_000 });
      await chatMenuButton.click();
      const moduleMenuItem = await driver.$(
        "//span[normalize-space()='Modules']",
      );
      await moduleMenuItem.waitForDisplayed({ timeout: 15_000 });
      await moduleMenuItem.click();

      await driver.waitUntil(
        async () =>
          driver?.execute(() => {
            const hasHeading = [...document.querySelectorAll("h2")].some(
              (heading) => heading.textContent?.trim() === "Modules",
            );
            return (
              hasHeading &&
              document.body.innerText.includes("Android E2E Module Actions") &&
              document.body.innerText.includes("Android E2E Prompt Rendering")
            );
          }),
        {
          timeout: 15_000,
          interval: 250,
          timeoutMsg: "The chat module menu did not open with its module",
        },
      );
    } catch (error) {
      const diagnostic = await driver
        .execute(() => ({
          bodyText: document.body.innerText.slice(0, 2_000),
          fixtureReady: localStorage.getItem(
            "risu_android_e2e_module_rendering_fixture_ready_v5",
          ),
          tosAccepted: localStorage.getItem("haejeok_tos_2026_08_23"),
          href: location.href,
        }))
        .catch(() => undefined);
      console.error("[android-e2e] module fixture diagnostic", diagnostic);
      await mkdir(artifactsDir, { recursive: true });
      await driver.saveScreenshot(
        join(artifactsDir, "module-chat-failure.png"),
      );
      throw error;
    }
  },
);
