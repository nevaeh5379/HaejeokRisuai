import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { remote } from "webdriverio";
import { buildTestLocalBackup } from "../tooling/backup-fixture";

const appiumUrl = new URL(
  process.env.ANDROID_E2E_APPIUM_URL ?? "http://127.0.0.1:4723",
);
const apkPath = process.env.ANDROID_E2E_APK;
const artifactsDir =
  process.env.ANDROID_E2E_ARTIFACTS ?? "android-e2e/artifacts";
const chromedriverDir =
  process.env.ANDROID_E2E_CHROMEDRIVER_DIR ??
  join(artifactsDir, "chromedrivers");
const remoteProfile = Boolean(process.env.ANDROID_E2E_REMOTE_URL?.trim());
let driver: WebdriverIO.Browser | undefined;

afterEach(async () => {
  if (driver) {
    await driver.deleteSession().catch(() => undefined);
    driver = undefined;
  }
});

async function startDriver() {
  assert.ok(apkPath, "ANDROID_E2E_APK must point to the debug APK");
  await mkdir(chromedriverDir, { recursive: true });
  driver = await remote({
    protocol: appiumUrl.protocol.replace(":", ""),
    hostname: appiumUrl.hostname,
    port: Number(appiumUrl.port),
    path: "/",
    logLevel: "warn",
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
      "appium:enforceAppInstall": true,
      "appium:autoGrantPermissions": true,
      "appium:noReset": false,
      "appium:newCommandTimeout": 120,
      "appium:ensureWebviewsHavePages": true,
      "appium:chromedriverExecutableDir": chromedriverDir,
    },
  });
  return driver;
}

async function switchToAppWebView(browser: WebdriverIO.Browser) {
  let context: string | undefined;
  await browser.waitUntil(
    async () => {
      const contexts = (await browser.getContexts()) as string[];
      context =
        contexts.find((item) => item === "WEBVIEW_co.aiclient.risu") ??
        contexts.find(
          (item) => item.startsWith("WEBVIEW_") && item !== "WEBVIEW_chrome",
        );
      return Boolean(context);
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "Capacitor WebView context did not appear",
    },
  );
  assert.ok(context);
  await browser.switchContext(context);
}

async function waitForFixture(browser: WebdriverIO.Browser) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          localStorage.getItem(
            "risu_android_e2e_module_rendering_fixture_ready_v5",
          ) === "true",
      ),
    {
      timeout: 90_000,
      interval: 500,
      timeoutMsg: "Android E2E fixture did not become ready",
    },
  );
}

async function waitForRestoredFixture(browser: WebdriverIO.Browser) {
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute(() =>
          (document.body?.innerText ?? "").includes("Fixture Bot"),
        );
      } catch {
        await browser.switchContext("NATIVE_APP").catch(() => undefined);
        const contexts = (await browser
          .getContexts()
          .catch(() => [])) as string[];
        const webview =
          contexts.find((item) => item === "WEBVIEW_co.aiclient.risu") ??
          contexts.find(
            (item) => item.startsWith("WEBVIEW_") && item !== "WEBVIEW_chrome",
          );
        if (webview) {
          await browser.switchContext(webview).catch(() => undefined);
        }
        return false;
      }
    },
    {
      timeout: 120_000,
      interval: 750,
      timeoutMsg: "Restored Fixture Bot did not appear after Android import",
    },
  );
}
async function openBackupSettingsPage(browser: WebdriverIO.Browser) {
  const clickVisibleSettings = async () =>
    await browser.execute(() => {
      const candidates = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ];
      const button =
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Settings tab"]',
        ) ??
        candidates.find((item) => {
          if (item.getClientRects().length === 0) return false;
          return /^(Settings|설정)$/.test(item.textContent?.trim() ?? "");
        });
      button?.click();
      return Boolean(button);
    });

  let openedSettings = await clickVisibleSettings();
  if (!openedSettings) {
    const openedSidebar = await browser.execute(() => {
      const toggle =
        document.querySelector<HTMLButtonElement>(".rs-sidebar-toggle");
      toggle?.click();
      return Boolean(toggle);
    });
    assert.equal(
      openedSidebar,
      true,
      "Neither the mobile Settings tab nor the sidebar toggle was available",
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const menu = document.querySelector<HTMLButtonElement>(
            ".rs-sidebar-menu-button",
          );
          if (!menu || menu.getClientRects().length === 0) return false;
          menu.click();
          return true;
        }),
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: "Sidebar hamburger menu did not appear",
      },
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const settings = document.querySelector<HTMLButtonElement>(
            ".rs-sidebar-menu-popover button.ico",
          );
          if (!settings || settings.getClientRects().length === 0) return false;
          settings.click();
          return true;
        }),
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: "Settings icon did not appear in the sidebar menu",
      },
    );
    openedSettings = true;
  }
  assert.equal(openedSettings, true);

  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) =>
            /Data.*Backup|Backup.*Data|데이터.*백업/i.test(
              button.textContent ?? "",
            ),
        ),
      ),
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "Data & Backup settings entry did not appear",
    },
  );

  const openedBackupPage = await browser.execute(() => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) =>
      /Data.*Backup|Backup.*Data|데이터.*백업/i.test(item.textContent ?? ""),
    );
    button?.click();
    return Boolean(button);
  });
  assert.equal(openedBackupPage, true);
}

async function openCompatibleBackupSave(browser: WebdriverIO.Browser) {
  await openBackupSettingsPage(browser);
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(
          document.querySelector(
            '[data-setting-id="backup.saveCompatible"] button',
          ),
        ),
      ),
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "Compatible backup action did not appear",
    },
  );

  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>(
        '[data-setting-id="backup.saveCompatible"] button',
      )
      ?.click();
  });
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.trim() === "YES",
        ),
      ),
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: "Backup confirmation did not appear",
    },
  );
  await browser.execute(() => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "YES")
      ?.click();
  });
}

async function waitForNativeDocumentSaver(browser: WebdriverIO.Browser) {
  await browser.switchContext("NATIVE_APP");
  await browser.waitUntil(
    async () => {
      const source = await browser.getPageSource();
      return /risu_compatible_backup_\d{4}-\d{2}-\d{2}/i.test(source);
    },
    {
      timeout: 15_000,
      interval: 300,
      timeoutMsg:
        "Android document saver did not open with the compatible backup filename",
    },
  );
}

function runAdb(args: string[]): string {
  const scopedArgs = process.env.ANDROID_E2E_UDID
    ? ["-s", process.env.ANDROID_E2E_UDID, ...args]
    : args;
  return execFileSync("adb", scopedArgs, { encoding: "utf8" });
}

async function stageImportFixture(): Promise<string> {
  const fileName = "haejeokrisu_android_e2e_import.risubackup";
  await mkdir(artifactsDir, { recursive: true });
  const hostPath = join(artifactsDir, fileName);
  await writeFile(hostPath, buildTestLocalBackup());
  runAdb(["shell", "mkdir", "-p", "/sdcard/Download"]);
  runAdb(["push", hostPath, `/sdcard/Download/${fileName}`]);
  runAdb([
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d",
    `file:///sdcard/Download/${fileName}`,
  ]);
  return fileName;
}

async function confirmNativeDocumentSave(browser: WebdriverIO.Browser) {
  const selectors = [
    "//*[@resource-id='com.google.android.documentsui:id/action_menu_save']",
    "//*[@resource-id='com.android.documentsui:id/action_menu_save']",
    "//*[@text='SAVE' or @text='Save' or @text='저장']",
    "//*[@content-desc='Save' or @content-desc='저장']",
  ];
  for (const selector of selectors) {
    const button = await browser.$(selector);
    if (await button.isDisplayed().catch(() => false)) {
      await button.click();
      return;
    }
  }
  throw new Error("Android document saver did not expose a Save action");
}

async function clickWebviewYes(browser: WebdriverIO.Browser) {
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.trim() === "YES",
        ),
      ),
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: "Backup confirmation did not appear",
    },
  );
  await browser.execute(() => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "YES")
      ?.click();
  });
}

async function openLocalBackupRestore(browser: WebdriverIO.Browser) {
  await openBackupSettingsPage(browser);
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(
          document.querySelector('[data-setting-id="backup.loadLocal"] button'),
        ),
      ),
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "Local backup restore action did not appear",
    },
  );
  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>(
        '[data-setting-id="backup.loadLocal"] button',
      )
      ?.click();
  });
  await clickWebviewYes(browser);
  await clickWebviewYes(browser);
}

async function selectNativeDocument(
  browser: WebdriverIO.Browser,
  fileName: string,
) {
  await browser.switchContext("NATIVE_APP");
  const fileSelector = `//*[@text="${fileName}"]`;
  const hasFile = async () =>
    await browser
      .$(fileSelector)
      .then((element) => element.isDisplayed())
      .catch(() => false);

  if (!(await hasFile())) {
    const roots = await browser.$(
      "//*[@content-desc='Show roots' or @content-desc='루트 표시']",
    );
    if (await roots.isDisplayed().catch(() => false)) {
      await roots.click();
    }

    await browser.waitUntil(
      async () => {
        for (const selector of [
          "//*[@text='Downloads' or @text='다운로드']",
          "//*[@content-desc='Downloads' or @content-desc='다운로드']",
        ]) {
          const downloads = await browser.$(selector);
          if (await downloads.isDisplayed().catch(() => false)) {
            await downloads.click();
            return true;
          }
        }
        return false;
      },
      {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: "Android document picker did not expose Downloads",
      },
    );
  }

  await browser.waitUntil(hasFile, {
    timeout: 15_000,
    interval: 300,
    timeoutMsg: `Android document picker did not show ${fileName}`,
  });
  await (await browser.$(fileSelector)).click();
}

test(
  "local Android backup opens the native document saver",
  { timeout: 180_000, skip: remoteProfile, concurrency: false },
  async () => {
    const browser = await startDriver();
    try {
      await switchToAppWebView(browser);
      await waitForFixture(browser);
      await openCompatibleBackupSave(browser);

      await waitForNativeDocumentSaver(browser);

      const source = await browser.getPageSource();
      assert.match(source, /risu_compatible_backup_\d{4}-\d{2}-\d{2}/i);
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await browser
        .saveScreenshot(join(artifactsDir, "local-backup-failure.png"))
        .catch(() => undefined);
      throw error;
    }
  },
);

test(
  "Android backup restore selects a real document and restores the fixture",
  { timeout: 240_000, concurrency: false },
  async () => {
    const browser = await startDriver();
    const fileName = await stageImportFixture();
    try {
      await switchToAppWebView(browser);
      await waitForFixture(browser);
      await openLocalBackupRestore(browser);
      await selectNativeDocument(browser, fileName);
      await waitForRestoredFixture(browser);

      const bodyText = await browser.execute(
        () => document.body?.innerText ?? "",
      );
      assert.match(bodyText, /Fixture Bot/);
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await browser
        .saveScreenshot(join(artifactsDir, "backup-restore-failure.png"))
        .catch(() => undefined);
      throw error;
    } finally {
      runAdb(["shell", "rm", "-f", `/sdcard/Download/${fileName}`]);
    }
  },
);

test(
  "remote-profile Android backup completes through the backup API",
  { timeout: 180_000, skip: !remoteProfile, concurrency: false },
  async () => {
    const browser = await startDriver();
    try {
      await switchToAppWebView(browser);
      await waitForFixture(browser);
      await openCompatibleBackupSave(browser);
      await waitForNativeDocumentSaver(browser);
      await confirmNativeDocumentSave(browser);
      await switchToAppWebView(browser);

      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const body = document.body?.innerText ?? "";
            return body.includes("Success");
          }),
        {
          timeout: 90_000,
          interval: 500,
          timeoutMsg: "Remote backup did not reach the Success state",
        },
      );

      const bodyText = await browser.execute(
        () => document.body?.innerText ?? "",
      );
      assert.match(bodyText, /Success/);
      assert.doesNotMatch(bodyText, /Local backup download failed|Error/i);
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await browser
        .saveScreenshot(join(artifactsDir, "remote-backup-failure.png"))
        .catch(() => undefined);
      throw error;
    }
  },
);
