import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { isTauriWindows } from "../platform";
import { ensureFluentWindowsBackdrop } from "../windowsTransparency";

export type UITheme = "default" | "windows";

export const FLUENT_FONT_STACK =
  '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, "Segoe UI Emoji", system-ui, sans-serif';

/**
 * Returns the currently active UI Theme.
 */
export function getUITheme(): UITheme {
  const current = settingsStore.state?.uiTheme;
  return current === "windows" ? "windows" : "default";
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

  document.documentElement.classList.toggle("theme-windows-fluent", isWindows);

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

  if (root && (!db?.font || db.font === "default")) {
    if (isWindows) {
      root.style.setProperty("--risu-font-family", FLUENT_FONT_STACK);
    } else {
      root.style.setProperty("--risu-font-family", "Arial, sans-serif");
    }
  }

  if (isWindows && isTauriWindows) {
    void ensureFluentWindowsBackdrop();
  }
}

/**
 * Sets the active UI Theme and immediately applies it.
 */
export function setUITheme(theme: UITheme): void {
  settingsStore.state.uiTheme = theme;
  applyUITheme(theme);
}
