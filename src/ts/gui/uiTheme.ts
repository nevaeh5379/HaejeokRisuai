import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { isCapacitorAndroid, isTauriWindows } from "../platform";
import { applyAndroidDynamicPalette } from "../android/androidNativeIntegration";
import { ensureFluentWindowsBackdrop } from "../windowsTransparency";

export type UITheme = "default" | "windows" | "android";

export const FLUENT_FONT_STACK =
  '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, "Segoe UI Emoji", system-ui, sans-serif';

/**
 * Returns the currently active UI Theme.
 */
export function getUITheme(): UITheme {
  const current = settingsStore.state?.uiTheme;
  if (current === "windows") return "windows";
  if (current === "android") return "android";
  return "default";
}

/**
 * Checks whether the Windows 11 Fluent UI Theme is active.
 */
export function isWindowsFluentTheme(): boolean {
  return getUITheme() === "windows";
}

/**
 * Applies the specified (or persisted) UI Theme across the application DOM.
 */
export function applyUITheme(theme?: string): void {
  if (typeof document === "undefined") return;

  const targetTheme = (theme ?? getUITheme()) as UITheme;
  const isWindows = targetTheme === "windows";
  const isAndroid = targetTheme === "android" && isCapacitorAndroid;

  document.documentElement.classList.toggle("theme-windows-fluent", isWindows);
  document.documentElement.classList.toggle("theme-android-material", isAndroid);

  const root = document.querySelector(":root") as HTMLElement | null;
  const db = settingsStore.state;
  const isDark = db?.colorScheme?.type !== "light";

  document.documentElement.classList.toggle(
    "theme-windows-fluent-dark",
    isWindows && isDark,
  );
  document.documentElement.classList.toggle(
    "theme-windows-fluent-light",
    isWindows && !isDark,
  );
  document.documentElement.classList.toggle(
    "theme-android-material-dark",
    isAndroid && isDark,
  );
  document.documentElement.classList.toggle(
    "theme-android-material-light",
    isAndroid && !isDark,
  );

  if (root && (!db?.font || db.font === "default")) {
    if (isWindows) {
      root.style.setProperty("--risu-font-family", FLUENT_FONT_STACK);
    } else if (isAndroid) {
      root.style.setProperty(
        "--risu-font-family",
        'Roboto, "Noto Sans", system-ui, sans-serif',
      );
    } else {
      root.style.setProperty("--risu-font-family", "Arial, sans-serif");
    }
  }

  if (isWindows && isTauriWindows) {
    void ensureFluentWindowsBackdrop();
  }
  if (isAndroid) {
    void applyAndroidDynamicPalette(isDark);
  }
}

/**
 * Sets the active UI Theme and immediately applies it.
 */
export function setUITheme(theme: UITheme): void {
  settingsStore.state.uiTheme = theme;
  applyUITheme(theme);
}
