import { Capacitor, registerPlugin } from "@capacitor/core";

export type AndroidNativeEntry = {
  type:
    | "share-text"
    | "process-text"
    | "open-chat"
    | "open-character"
    | "new-chat";
  text?: string;
  subject?: string;
  mimeType?: string;
  characterId?: string;
  chatId?: string;
};

export interface AndroidShortcutItem {
  characterId: string;
  chatId: string;
  label: string;
}

export interface AndroidRecentChatWidgetItem {
  characterId: string;
  chatId: string;
  characterName: string;
  chatName: string;
  lastMessage: string;
}

interface NativeIntegrationPlugin {
  consumePendingEntries(): Promise<{ entries: AndroidNativeEntry[] }>;
  updateShortcuts(options: {
    items: AndroidShortcutItem[];
  }): Promise<{ updated: number }>;
  updateRecentChatWidget(options: {
    item: AndroidRecentChatWidgetItem | null;
  }): Promise<void>;
  setSystemBarAppearance(options: { dark: boolean }): Promise<void>;
  requestPinRecentChatWidget(): Promise<{
    supported: boolean;
    accepted: boolean;
  }>;
  requestQuickSettingsTile(): Promise<{
    supported: boolean;
    result: number;
  }>;
}

const isAndroidNative =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const nativeIntegration = isAndroidNative
  ? registerPlugin<NativeIntegrationPlugin>("NativeIntegration")
  : null;

export function usesAndroidNativeIntegration(): boolean {
  return nativeIntegration !== null;
}

export async function updateAndroidShortcuts(
  items: AndroidShortcutItem[],
): Promise<number> {
  if (!nativeIntegration) return 0;
  try {
    return (await nativeIntegration.updateShortcuts({ items })).updated;
  } catch (error) {
    console.warn("[NativeIntegration] Failed to update Android shortcuts:", error);
    return 0;
  }
}

export async function updateAndroidRecentChatWidget(
  item: AndroidRecentChatWidgetItem | null,
): Promise<void> {
  if (!nativeIntegration) return;
  try {
    await nativeIntegration.updateRecentChatWidget({ item });
  } catch (error) {
    console.warn("[NativeIntegration] Failed to update Android widget:", error);
  }
}

export async function syncAndroidSystemBars(dark: boolean): Promise<void> {
  if (!nativeIntegration) return;
  try {
    await nativeIntegration.setSystemBarAppearance({ dark });
  } catch (error) {
    console.warn("[NativeIntegration] Failed to sync Android system bars:", error);
  }
}

export async function requestAndroidRecentChatWidget(): Promise<{
  supported: boolean;
  accepted: boolean;
}> {
  if (!nativeIntegration) return { supported: false, accepted: false };
  return nativeIntegration.requestPinRecentChatWidget();
}

export async function requestAndroidQuickSettingsTile(): Promise<{
  supported: boolean;
  result: number;
}> {
  if (!nativeIntegration) return { supported: false, result: -1 };
  return nativeIntegration.requestQuickSettingsTile();
}

export function installAndroidNativeEntryHandler(
  handler: (entry: AndroidNativeEntry) => void | Promise<void>,
): () => void {
  if (!nativeIntegration || typeof window === "undefined") return () => {};

  let disposed = false;
  let draining: Promise<void> | null = null;

  const drain = () => {
    if (draining) return draining;
    draining = (async () => {
      try {
        do {
          const result = await nativeIntegration.consumePendingEntries();
          if (disposed || result.entries.length === 0) break;
          for (const entry of result.entries) {
            if (disposed) break;
            await handler(entry);
          }
        } while (!disposed);
      } catch (error) {
        console.warn("[NativeIntegration] Failed to consume Android entry:", error);
      } finally {
        draining = null;
      }
    })();
    return draining;
  };

  const onAvailable = () => void drain();
  window.addEventListener("risu:native-entry-available", onAvailable);
  void drain();

  return () => {
    disposed = true;
    window.removeEventListener("risu:native-entry-available", onAvailable);
  };
}
