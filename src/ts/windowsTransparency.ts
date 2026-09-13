import { isTauriWindows } from "./platform";

export type WindowsBackdropEffect = "acrylic" | "mica" | "tabbed";

export interface WindowsTransparencyPreferences {
  enabled: boolean;
  effect: WindowsBackdropEffect;
  opacity: number;
}

const STORAGE_KEY = "risu.windowsTransparency.v1";
const CHANGE_EVENT = "risu://windows-transparency-changed";
const DEFAULT_PREFERENCES: WindowsTransparencyPreferences = {
  enabled: true,
  effect: "acrylic",
  opacity: 95,
};

let eventListenerReady = false;

function normalizePreferences(
  value: Partial<WindowsTransparencyPreferences> | null | undefined,
): WindowsTransparencyPreferences {
  const effect: WindowsBackdropEffect =
    value?.effect === "mica" || value?.effect === "tabbed"
      ? value.effect
      : "acrylic";
  const opacity = Number(value?.opacity);

  return {
    enabled:
      typeof value?.enabled === "boolean"
        ? value.enabled
        : DEFAULT_PREFERENCES.enabled,
    effect,
    opacity: Number.isFinite(opacity)
      ? Math.min(100, Math.max(0, Math.round(opacity)))
      : DEFAULT_PREFERENCES.opacity,
  };
}

export function getWindowsTransparencyPreferences(): WindowsTransparencyPreferences {
  if (!isTauriWindows || typeof localStorage === "undefined") {
    return { ...DEFAULT_PREFERENCES };
  }

  try {
    return normalizePreferences(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function applyWindowsTransparencyToDocument(
  preferences = getWindowsTransparencyPreferences(),
): void {
  if (!isTauriWindows || typeof document === "undefined") return;

  document.documentElement.classList.toggle(
    "tauri-windows-vibrancy",
    preferences.enabled,
  );
  document.documentElement.style.setProperty(
    "--risu-windows-material-opacity",
    `${preferences.opacity}%`,
  );
}

async function syncNativeBackdrop(
  preferences: WindowsTransparencyPreferences,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_risu_windows_backdrop", {
    effect: preferences.enabled ? preferences.effect : "off",
  });
}

export async function initializeWindowsTransparency(): Promise<void> {
  if (!isTauriWindows) return;

  const preferences = getWindowsTransparencyPreferences();
  applyWindowsTransparencyToDocument(preferences);

  if (!eventListenerReady) {
    eventListenerReady = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<WindowsTransparencyPreferences>(CHANGE_EVENT, (event) => {
      applyWindowsTransparencyToDocument(normalizePreferences(event.payload));
    });
  }

  try {
    await syncNativeBackdrop(preferences);
  } catch (error) {
    console.warn("Failed to apply the Windows backdrop preference:", error);
  }
}

export async function setWindowsTransparencyPreferences(
  value: WindowsTransparencyPreferences,
): Promise<WindowsTransparencyPreferences> {
  const preferences = normalizePreferences(value);
  if (!isTauriWindows) return preferences;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.warn("Failed to save the Windows transparency preference:", error);
  }

  applyWindowsTransparencyToDocument(preferences);

  try {
    const [{ emit }] = await Promise.all([
      import("@tauri-apps/api/event"),
      syncNativeBackdrop(preferences),
    ]);
    await emit(CHANGE_EVENT, preferences);
  } catch (error) {
    console.warn("Failed to apply the Windows transparency preference:", error);
  }

  return preferences;
}

export async function ensureFluentWindowsBackdrop(): Promise<void> {
  if (!isTauriWindows) return;
  const preferences = getWindowsTransparencyPreferences();
  try {
    await syncNativeBackdrop(preferences);
  } catch (error) {
    console.warn("Failed to apply the Windows transparency preference:", error);
  }
}
