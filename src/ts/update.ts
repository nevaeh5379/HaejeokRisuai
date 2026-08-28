import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  alertClear,
  alertConfirm,
  alertError,
  alertProgress,
  alertSelect,
} from "./alert";
import { language } from "../lang";
import { isCapacitor, isTauri } from "./platform";

const UPDATE_REMINDER_KEY = "risu_update_reminder";
const isAndroidNative =
  isCapacitor && Capacitor.getPlatform() === "android";

type ListenerHandle = { remove(): Promise<void> };

type AndroidUpdateCheck = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  latestVersionCode: number;
};

type AndroidDownloadProgress = {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
};

interface NativeUpdaterPlugin {
  check(): Promise<AndroidUpdateCheck>;
  downloadAndInstall(): Promise<void>;
  addListener(
    eventName: "downloadProgress",
    listener: (event: AndroidDownloadProgress) => void,
  ): Promise<ListenerHandle>;
}

const nativeUpdater = isAndroidNative
  ? registerPlugin<NativeUpdaterPlugin>("NativeUpdater")
  : null;

interface UpdateReminder {
  version: string;
  until?: number;
  ignored?: boolean;
}

interface UpdateCandidate {
  version: string;
  currentVersion: string;
  install: () => Promise<void>;
}

let activeUpdateCheck: Promise<void> | null = null;

function getUpdateReminder(): UpdateReminder | null {
  try {
    const stored = localStorage.getItem(UPDATE_REMINDER_KEY);
    return stored ? (JSON.parse(stored) as UpdateReminder) : null;
  } catch {
    return null;
  }
}

function setUpdateReminder(version: string, days: number): void {
  localStorage.setItem(
    UPDATE_REMINDER_KEY,
    JSON.stringify({
      version,
      until: Date.now() + days * 24 * 60 * 60 * 1000,
    } satisfies UpdateReminder),
  );
}

function ignoreUpdate(version: string): void {
  localStorage.setItem(
    UPDATE_REMINDER_KEY,
    JSON.stringify({ version, ignored: true } satisfies UpdateReminder),
  );
}

function clearUpdateReminder(): void {
  localStorage.removeItem(UPDATE_REMINDER_KEY);
}

function isUpdateReminderActive(version: string): boolean {
  const reminder = getUpdateReminder();
  if (!reminder) return false;
  if (reminder.version !== version) {
    clearUpdateReminder();
    return false;
  }
  if (reminder.ignored) return true;
  if ((reminder.until ?? 0) > Date.now()) return true;
  clearUpdateReminder();
  return false;
}

function showDownloadProgress(
  version: string,
  downloaded: number,
  total: number,
): void {
  const percent = total > 0 ? (downloaded / total) * 100 : 0;
  alertProgress(`Updating to ${version}...`, percent);
}

async function getTauriUpdate(): Promise<UpdateCandidate | null> {
  if (!isTauri) return null;
  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    install: async () => {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          showDownloadProgress(update.version, 0, total);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          showDownloadProgress(update.version, downloaded, total);
        } else if (event.event === "Finished") {
          alertProgress(`Updating to ${update.version}...`, 100);
        }
      });
      await relaunch();
    },
  };
}

async function getAndroidUpdate(): Promise<UpdateCandidate | null> {
  if (!nativeUpdater) return null;
  const checked = await nativeUpdater.check();
  if (!checked.available) return null;
  return {
    version: checked.latestVersion,
    currentVersion: checked.currentVersion,
    install: async () => {
      const listener = await nativeUpdater.addListener(
        "downloadProgress",
        (event) => {
          if (event.totalBytes > 0) {
            alertProgress(
              `Updating to ${checked.latestVersion}...`,
              event.percent,
            );
          } else {
            alertProgress(`Updating to ${checked.latestVersion}...`, 0);
          }
        },
      );
      try {
        await nativeUpdater.downloadAndInstall();
      } finally {
        await listener.remove();
      }
    },
  };
}

async function findUpdate(): Promise<UpdateCandidate | null> {
  if (isTauri) return getTauriUpdate();
  if (isAndroidNative) return getAndroidUpdate();
  return null;
}

async function promptForUpdate(candidate: UpdateCandidate): Promise<void> {
  if (isUpdateReminderActive(candidate.version)) return;

  const conf = await alertConfirm(
    `${language.newVersion}\n\n${candidate.currentVersion} → ${candidate.version}`,
  );
  if (conf) {
    clearUpdateReminder();
    try {
      alertProgress(`Updating to ${candidate.version}...`, 0);
      await candidate.install();
      alertClear();
    } catch (error) {
      alertClear();
      console.error("Failed to install application update:", error);
      alertError(
        error instanceof Error
          ? `Failed to install update: ${error.message}`
          : `Failed to install update: ${String(error)}`,
      );
    }
    return;
  }

  const selected = await alertSelect(
    [
      language.remindIgnore,
      language.remindLater1Day,
      language.remindLater3Days,
      language.remindLater5Days,
      language.remindLater1Week,
    ],
    language.remindLaterQuestion,
  );

  switch (Number.parseInt(selected, 10)) {
    case 0:
      ignoreUpdate(candidate.version);
      break;
    case 1:
      setUpdateReminder(candidate.version, 1);
      break;
    case 2:
      setUpdateReminder(candidate.version, 3);
      break;
    case 3:
      setUpdateReminder(candidate.version, 5);
      break;
    case 4:
      setUpdateReminder(candidate.version, 7);
      break;
  }
}

async function checkRisuUpdateInternal(): Promise<void> {
  if (!isTauri && !isAndroidNative) return;
  try {
    const candidate = await findUpdate();
    if (candidate) await promptForUpdate(candidate);
  } catch (error) {
    console.warn("Failed to check for application updates:", error);
  }
}

export function checkRisuUpdate(): Promise<void> {
  if (!activeUpdateCheck) {
    activeUpdateCheck = checkRisuUpdateInternal().finally(() => {
      activeUpdateCheck = null;
    });
  }
  return activeUpdateCheck;
}