import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { remote } from "webdriverio";
import { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";
import { RemoteAuthController } from "@risuai/storage-remote/remoteAuthController";
import { RemoteAuthIdentity } from "@risuai/storage-remote/remoteAuthIdentity";
import { LOCAL_BACKUP_IMPORT_UPLOAD_CHUNK_SIZE } from "@risuai/storage-remote/remoteLocalBackupClient";
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
const remoteUrl = process.env.ANDROID_E2E_REMOTE_URL?.trim() ?? "";
const remotePassword = process.env.ANDROID_E2E_REMOTE_PASSWORD ?? "";
const remoteProfile = Boolean(remoteUrl);
let driver: WebdriverIO.Browser | undefined;

afterEach(async () => {
  if (driver) {
    await driver.deleteSession().catch(() => undefined);
    driver = undefined;
  }
});

async function startDriver(options: { preserveData?: boolean } = {}) {
  const preserveData = options.preserveData ?? false;
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
      ...(preserveData
        ? {}
        : {
            "appium:app": apkPath,
            "appium:enforceAppInstall": true,
          }),
      "appium:appPackage": "co.aiclient.risu",
      "appium:appActivity": ".MainActivity",
      "appium:autoGrantPermissions": true,
      "appium:noReset": preserveData,
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

function isDisconnectedWebViewError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnected: not connected to DevTools|chrome not reachable|no such window/i.test(
    message,
  );
}

async function reconnectPreservingAppData(
  browser: WebdriverIO.Browser,
): Promise<WebdriverIO.Browser> {
  await browser.deleteSession().catch(() => undefined);
  if (driver === browser) driver = undefined;
  const reconnected = await startDriver({ preserveData: true });
  await switchToAppWebView(reconnected);
  return reconnected;
}

async function waitForFixture(
  browser: WebdriverIO.Browser,
): Promise<WebdriverIO.Browser> {
  let current = browser;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const ready = await current.execute(
        (allowPersistedRemoteFixture) =>
          localStorage.getItem(
            "risu_android_e2e_module_rendering_fixture_ready_v5",
          ) === "true" ||
          (allowPersistedRemoteFixture &&
            (document.body?.innerText ?? "").includes(
              "Android E2E Module Rendering Character",
            )),
        remoteProfile,
      );
      if (ready) return current;
    } catch (error) {
      if (!remoteProfile || !isDisconnectedWebViewError(error)) throw error;
      current = await reconnectPreservingAppData(current);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Android E2E fixture did not become ready");
}

const ANDROID_SQLITE_PATH = "databases/risuai-localSQLite.db";
const RESTORED_FIXTURE_MARKERS = [
  "Fixture Bot",
  "aaaaaaaa-1111-4222-8333-444444444444",
];

function runAdbBinary(args: string[]): Buffer {
  const scopedArgs = process.env.ANDROID_E2E_UDID
    ? ["-s", process.env.ANDROID_E2E_UDID, ...args]
    : args;
  return execFileSync("adb", scopedArgs);
}

function readAndroidDatabaseBytes(suffix = ""): Buffer {
  try {
    return runAdbBinary([
      "exec-out",
      "run-as",
      "co.aiclient.risu",
      "cat",
      `${ANDROID_SQLITE_PATH}${suffix}`,
    ]);
  } catch {
    return Buffer.alloc(0);
  }
}

async function createRemoteVerifier() {
  assert.ok(remoteUrl, "ANDROID_E2E_REMOTE_URL is required");
  assert.ok(remotePassword, "ANDROID_E2E_REMOTE_PASSWORD is required");
  const verifierUrl = new URL(remoteUrl);
  if (verifierUrl.hostname === "10.0.2.2") {
    verifierUrl.hostname = "127.0.0.1";
  }
  const baseUrl = verifierUrl.origin;
  const api = new NodeApiClient({
    version: 1,
    mode: "remote",
    baseUrl,
    allowInsecureHttp: baseUrl.startsWith("http://"),
  });
  let keyPair: CryptoKeyPair | null = null;
  const identity = new RemoteAuthIdentity(
    api,
    async () => keyPair,
    async (_name, value) => {
      keyPair = value;
    },
  );
  const auth = new RemoteAuthController(api, identity, {
    createAuth: () => identity.createAuth(),
    requestPassword: async () => remotePassword,
  });
  await auth.connectWithPassword(remotePassword);
  return { api, auth };
}

async function waitForRemoteRestoredFixture(
  browser: WebdriverIO.Browser,
  characterId: string,
) {
  const { api, auth } = await createRemoteVerifier();
  const deadline = Date.now() + 90_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await api.request(
      `/api/database-v2/characters/${characterId}`,
      {
        method: "GET",
        cache: "no-store",
        headers: { "risu-auth": await auth.getCachedAuth() },
      },
    );
    lastStatus = response.status;
    if (response.ok) {
      const body = await response.json();
      if (body?.character?.name === "Fixture Bot") return;
    } else if (response.status !== 404 && response.status !== 423) {
      throw new Error(
        `Remote restore verification failed (HTTP ${response.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  let bodyText = "";
  try {
    await switchToAppWebView(browser);
    bodyText = String(
      await browser.execute(() => document.body?.innerText ?? ""),
    );
  } catch {}
  throw new Error(
    `Remote restore did not persist Fixture Bot on the server (last HTTP ${lastStatus || "none"})${bodyText ? `\nWebView text:\n${bodyText.slice(0, 3000)}` : ""}`,
  );
}

async function waitForRestoredFixtureInSqlite(browser: WebdriverIO.Browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const bytes = Buffer.concat([
      readAndroidDatabaseBytes(),
      readAndroidDatabaseBytes("-wal"),
    ]);
    if (
      RESTORED_FIXTURE_MARKERS.every((marker) =>
        bytes.includes(Buffer.from(marker, "utf8")),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  let bodyText = "";
  try {
    await switchToAppWebView(browser);
    bodyText = String(
      await browser.execute(() => document.body?.innerText ?? ""),
    );
  } catch {}
  throw new Error(
    `Restored Fixture Bot was not persisted to Android SQLite${bodyText ? `\nWebView text:\n${bodyText.slice(0, 3000)}` : ""}`,
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

async function stageImportFixture(
  options?: Parameters<typeof buildTestLocalBackup>[0],
): Promise<{ fileName: string; byteLength: number }> {
  const fileName = "haejeokrisu_android_e2e_import.risubackup";
  await mkdir(artifactsDir, { recursive: true });
  const hostPath = join(artifactsDir, fileName);
  const fixture = buildTestLocalBackup(options);
  await writeFile(hostPath, fixture);
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
  return { fileName, byteLength: fixture.byteLength };
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
  const waitForFile = async (timeout: number) => {
    try {
      await browser.waitUntil(hasFile, {
        timeout,
        interval: 250,
        timeoutMsg: `Android document picker did not show ${fileName}`,
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await hasFile())) {
    const search = await browser.$(
      "//*[@content-desc='Search' or @content-desc='검색']",
    );
    if (await search.isDisplayed().catch(() => false)) {
      await search.click();
      const input = await browser.$(
        "//*[@resource-id='com.google.android.documentsui:id/search_src_text' or @class='android.widget.EditText']",
      );
      if (await input.isDisplayed().catch(() => false)) {
        await input.setValue(fileName);
        if (await waitForFile(5_000)) {
          await (await browser.$(fileSelector)).click();
          return;
        }
      }
      await browser.back().catch(() => undefined);
    }

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
    let browser = await startDriver();
    try {
      await switchToAppWebView(browser);
      browser = await waitForFixture(browser);
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
  "Android backup restore selects a real document and persists the fixture",
  { timeout: 240_000, skip: remoteProfile, concurrency: false },
  async () => {
    let browser = await startDriver();
    const { fileName } = await stageImportFixture();
    try {
      await switchToAppWebView(browser);
      browser = await waitForFixture(browser);
      await openLocalBackupRestore(browser);
      await selectNativeDocument(browser, fileName);
      await waitForRestoredFixtureInSqlite(browser);
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
    let browser = await startDriver();
    try {
      await switchToAppWebView(browser);
      browser = await waitForFixture(browser);
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

test(
  "remote-profile Android restore uploads bounded chunks and replaces server data",
  { timeout: 240_000, skip: !remoteProfile, concurrency: false },
  async () => {
    let browser = await startDriver();
    const characterId = randomUUID();
    const { fileName, byteLength } = await stageImportFixture({
      characterId,
      chatId: randomUUID(),
      paddingAssetBytes: LOCAL_BACKUP_IMPORT_UPLOAD_CHUNK_SIZE + 128 * 1024,
    });
    assert.ok(
      byteLength > LOCAL_BACKUP_IMPORT_UPLOAD_CHUNK_SIZE,
      "Remote restore fixture must exceed one HTTP upload chunk",
    );
    try {
      await switchToAppWebView(browser);
      browser = await waitForFixture(browser);
      await openLocalBackupRestore(browser);
      await selectNativeDocument(browser, fileName);
      await waitForRemoteRestoredFixture(browser, characterId);
    } catch (error) {
      await mkdir(artifactsDir, { recursive: true });
      await browser
        .saveScreenshot(join(artifactsDir, "remote-restore-failure.png"))
        .catch(() => undefined);
      throw error;
    } finally {
      runAdb(["shell", "rm", "-f", `/sdcard/Download/${fileName}`]);
    }
  },
);
