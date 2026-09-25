import { Capacitor, registerPlugin } from "@capacitor/core";

export type AndroidNativeEntry = {
  type:
    "share-text" | "process-text" | "open-chat" | "open-character" | "new-chat";
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
  iconData?: string | null;
}

interface NativeIntegrationPlugin {
  consumePendingEntries(): Promise<{ entries: AndroidNativeEntry[] }>;
  updateShortcuts(options: {
    items: AndroidShortcutItem[];
  }): Promise<{ updated: number }>;
  updateRecentChatWidget(options: {
    items: AndroidRecentChatWidgetItem[];
  }): Promise<void>;
  setSystemBarAppearance(options: { dark: boolean }): Promise<void>;
  setNavigationBarHidden(options: { hidden: boolean }): Promise<void>;
  getSystemPalette(): Promise<{
    available: boolean;
    accentLight?: string;
    accentDark?: string;
    accentContainerLight?: string;
    accentContainerDark?: string;
    surfaceLight?: string;
    surfaceDark?: string;
    surfaceHighLight?: string;
    surfaceHighDark?: string;
    onSurfaceLight?: string;
    onSurfaceDark?: string;
    onSurfaceVariantLight?: string;
    onSurfaceVariantDark?: string;
    outlineLight?: string;
    outlineDark?: string;
  }>;
  haptic(options: {
    type: "selection" | "confirm" | "reject" | "longPress";
  }): Promise<{ performed: boolean }>;
  requestPinRecentChatWidget(): Promise<{
    supported: boolean;
    accepted: boolean;
  }>;
  requestPinWidget(options: {
    type: "recent" | "compact" | "grid" | "strip";
  }): Promise<{
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
    console.warn(
      "[NativeIntegration] Failed to update Android shortcuts:",
      error,
    );
    return 0;
  }
}

export async function updateAndroidRecentChatWidget(
  items: AndroidRecentChatWidgetItem[],
): Promise<void> {
  if (!nativeIntegration) return;
  try {
    await nativeIntegration.updateRecentChatWidget({ items });
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to update Android widgets:",
      error,
    );
  }
}

export async function syncAndroidSystemBars(dark: boolean): Promise<void> {
  if (!nativeIntegration) return;
  try {
    await nativeIntegration.setSystemBarAppearance({ dark });
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to sync Android system bars:",
      error,
    );
  }
}

export async function setAndroidNavigationBarHidden(
  hidden: boolean,
): Promise<void> {
  if (!nativeIntegration) return;
  try {
    await nativeIntegration.setNavigationBarHidden({ hidden });
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to update Android navigation bar visibility:",
      error,
    );
  }
}

export async function applyAndroidDynamicPalette(dark: boolean): Promise<void> {
  if (!nativeIntegration || typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root.classList.contains("theme-android-material")) return;
  try {
    const palette = await nativeIntegration.getSystemPalette();
    if (
      !root.classList.contains("theme-android-material") ||
      !palette.available
    )
      return;

    const accent = dark ? palette.accentDark : palette.accentLight;
    const accentContainer = dark
      ? palette.accentContainerDark
      : palette.accentContainerLight;
    const surface = dark ? palette.surfaceDark : palette.surfaceLight;
    const surfaceHigh = dark
      ? palette.surfaceHighDark
      : palette.surfaceHighLight;
    const onSurface = dark ? palette.onSurfaceDark : palette.onSurfaceLight;
    const onSurfaceVariant = dark
      ? palette.onSurfaceVariantDark
      : palette.onSurfaceVariantLight;
    const outline = dark ? palette.outlineDark : palette.outlineLight;

    const set = (name: string, value?: string) => {
      if (value) root.style.setProperty(name, value);
    };
    set("--risu-android-system-accent", accent);
    set("--risu-android-system-accent-container", accentContainer);
    set("--risu-android-system-surface", surface);
    set("--risu-android-system-surface-high", surfaceHigh);
    set("--risu-android-system-on-surface", onSurface);
    set("--risu-android-system-on-surface-variant", onSurfaceVariant);
    set("--risu-android-system-outline", outline);

    // Feed the native palette into Risu's existing tokens so every surface,
    // not just one button, visibly follows Android's wallpaper-derived colors.
    set("--risu-theme-bgcolor", surface);
    set("--risu-theme-darkbg", surfaceHigh ?? surface);
    set("--risu-theme-borderc", accent);
    set("--risu-theme-selected", accentContainer ?? surfaceHigh);
    set("--risu-theme-textcolor", onSurface);
    set("--risu-theme-textcolor2", onSurfaceVariant);
    set("--risu-theme-darkborderc", outline);
    set("--risu-theme-darkbutton", accentContainer ?? surfaceHigh);
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to read Android dynamic colors:",
      error,
    );
  }
}

export async function triggerAndroidHaptic(
  type: "selection" | "confirm" | "reject" | "longPress",
): Promise<boolean> {
  if (!nativeIntegration) return false;
  try {
    return (await nativeIntegration.haptic({ type })).performed;
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to perform haptic feedback:",
      error,
    );
    return false;
  }
}

export type AndroidWidgetType = "recent" | "compact" | "grid" | "strip";

export async function requestAndroidWidget(type: AndroidWidgetType): Promise<{
  supported: boolean;
  accepted: boolean;
}> {
  if (!nativeIntegration) return { supported: false, accepted: false };
  return nativeIntegration.requestPinWidget({ type });
}

export async function requestAndroidRecentChatWidget(): Promise<{
  supported: boolean;
  accepted: boolean;
}> {
  return requestAndroidWidget("recent");
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
        console.warn(
          "[NativeIntegration] Failed to consume Android entry:",
          error,
        );
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
