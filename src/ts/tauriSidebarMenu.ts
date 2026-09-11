import type { MenuDef } from "./stores.svelte";
import {
  type as tauriOsType,
  version as tauriOsVersion,
} from "@tauri-apps/plugin-os";

const SIDEBAR_MENU_KIND_PARAM = "risuWindow";
const SIDEBAR_MENU_KIND = "sidebar-menu";
const SOURCE_WINDOW_PARAM = "sourceWindowLabel";
const POPUP_WINDOW_PARAM = "popupWindowLabel";
const POPUP_LABEL_PREFIX = "sidebar-menu-";
const POPUP_STORAGE_PREFIX = "risu:sidebar-menu-popup:";

export const TAURI_SIDEBAR_MENU_ACTION_EVENT = "risu://sidebar-menu-action";
export const TAURI_SIDEBAR_MENU_PAYLOAD_EVENT = "risu://sidebar-menu-payload";
export const TAURI_SIDEBAR_MENU_BLUR_ARM_EVENT = "risu://sidebar-menu-blur-arm";

export type TauriSidebarMenuBuiltinIcon =
  "settings" | "home" | "playground" | "search" | "grid";

export type TauriSidebarMenuAction =
  TauriSidebarMenuBuiltinIcon | `plugin:${string}`;

export interface TauriSidebarMenuItem {
  action: TauriSidebarMenuAction;
  name: string;
  iconType: "builtin" | "html" | "img" | "none";
  icon: string;
}

export interface TauriSidebarMenuPopupPayload {
  items: TauriSidebarMenuItem[];
  theme: {
    textColor: string;
    selectedColor: string;
    darkBg: string;
  };
}

export interface TauriSidebarMenuLaunch {
  sourceWindowLabel: string;
  popupWindowLabel: string;
}

export interface TauriSidebarMenuPlacementInput {
  sourceInnerPosition: { x: number; y: number };
  sourceScaleFactor: number;
  triggerRect: { left: number; top: number; width: number; height: number };
  popupWidth: number;
  popupHeight: number;
  workAreaPosition: { x: number; y: number };
  workAreaSize: { width: number; height: number };
  workAreaScaleFactor: number;
  gap?: number;
}

export type TauriSidebarMenuToggleResult = "opened" | "closed" | "unavailable";

export function supportsTauriLiquidGlassVersion(version: string): boolean {
  const major = Number.parseInt(version.trim().split(/[._-]/)[0] ?? "", 10);
  return Number.isFinite(major) && major >= 26;
}

export function isTauriMacOSRuntime(): boolean {
  if (
    typeof window === "undefined" ||
    !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  ) {
    return false;
  }

  try {
    return tauriOsType() === "macos";
  } catch {
    return false;
  }
}

export function parseTauriSidebarMenuLaunch(
  search: string,
): TauriSidebarMenuLaunch | null {
  const params = new URLSearchParams(search);
  if (params.get(SIDEBAR_MENU_KIND_PARAM) !== SIDEBAR_MENU_KIND) return null;
  const sourceWindowLabel = params.get(SOURCE_WINDOW_PARAM)?.trim();
  const popupWindowLabel = params.get(POPUP_WINDOW_PARAM)?.trim();
  if (!sourceWindowLabel || !popupWindowLabel?.startsWith(POPUP_LABEL_PREFIX)) {
    return null;
  }
  return { sourceWindowLabel, popupWindowLabel };
}

export function buildTauriSidebarMenuPopupUrl(
  sourceWindowLabel: string,
  popupWindowLabel: string,
  pathname = "/",
): string {
  const params = new URLSearchParams({
    [SIDEBAR_MENU_KIND_PARAM]: SIDEBAR_MENU_KIND,
    [SOURCE_WINDOW_PARAM]: sourceWindowLabel,
    [POPUP_WINDOW_PARAM]: popupWindowLabel,
  });
  return `${pathname || "/"}?${params.toString()}`;
}

export function createTauriSidebarMenuItems(
  pluginMenus: Pick<MenuDef, "id" | "name" | "icon" | "iconType">[],
): TauriSidebarMenuItem[] {
  return [
    {
      action: "settings",
      name: "Settings",
      iconType: "builtin",
      icon: "settings",
    },
    { action: "home", name: "Home", iconType: "builtin", icon: "home" },
    {
      action: "playground",
      name: "Playground",
      iconType: "builtin",
      icon: "playground",
    },
    { action: "search", name: "Search", iconType: "builtin", icon: "search" },
    ...pluginMenus.map((menu) => ({
      action: `plugin:${menu.id}` as const,
      name: menu.name,
      iconType: menu.iconType,
      icon: menu.icon,
    })),
    { action: "grid", name: "Characters", iconType: "builtin", icon: "grid" },
  ];
}

export function calculateTauriSidebarMenuPlacement(
  input: TauriSidebarMenuPlacementInput,
): { x: number; y: number } {
  const sourceScale =
    Number.isFinite(input.sourceScaleFactor) && input.sourceScaleFactor > 0
      ? input.sourceScaleFactor
      : 1;
  const workScale =
    Number.isFinite(input.workAreaScaleFactor) && input.workAreaScaleFactor > 0
      ? input.workAreaScaleFactor
      : sourceScale;
  const gap = input.gap ?? 8;
  const innerX = input.sourceInnerPosition.x / sourceScale;
  const innerY = input.sourceInnerPosition.y / sourceScale;
  const workX = input.workAreaPosition.x / workScale;
  const workY = input.workAreaPosition.y / workScale;
  const workWidth = input.workAreaSize.width / workScale;
  const workHeight = input.workAreaSize.height / workScale;

  const triggerCenterX =
    innerX + input.triggerRect.left + input.triggerRect.width / 2;
  let desiredX = triggerCenterX - input.popupWidth / 2;
  let desiredY = innerY + input.triggerRect.top - input.popupHeight - gap;

  if (desiredY < workY) {
    desiredY = innerY + input.triggerRect.top + input.triggerRect.height + gap;
  }

  const maxX = Math.max(workX, workX + workWidth - input.popupWidth);
  const maxY = Math.max(workY, workY + workHeight - input.popupHeight);
  desiredX = Math.min(Math.max(desiredX, workX), maxX);
  desiredY = Math.min(Math.max(desiredY, workY), maxY);

  return { x: Math.round(desiredX), y: Math.round(desiredY) };
}

function popupStorageKey(label: string): string {
  return `${POPUP_STORAGE_PREFIX}${label}`;
}

export function readTauriSidebarMenuPopupPayload(
  popupWindowLabel: string,
): TauriSidebarMenuPopupPayload | null {
  try {
    const raw = localStorage.getItem(popupStorageKey(popupWindowLabel));
    if (!raw) return null;
    localStorage.removeItem(popupStorageKey(popupWindowLabel));
    const payload = JSON.parse(raw) as TauriSidebarMenuPopupPayload;
    return Array.isArray(payload?.items) ? payload : null;
  } catch {
    return null;
  }
}

function readThemeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function createPopupLabel(sourceWindowLabel: string): string {
  const safeSource = sourceWindowLabel
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .slice(0, 48);
  return `${POPUP_LABEL_PREFIX}${safeSource}`;
}

function createPopupPayload(
  pluginMenus: Pick<MenuDef, "id" | "name" | "icon" | "iconType">[],
): TauriSidebarMenuPopupPayload {
  return {
    items: createTauriSidebarMenuItems(pluginMenus),
    theme: {
      textColor: readThemeColor("--risu-theme-textcolor", "#f5f5f5"),
      selectedColor: readThemeColor("--risu-theme-selected", "#44475a"),
      darkBg: readThemeColor("--risu-theme-darkbg", "#21222c"),
    },
  };
}

function popupDimensions(itemCount: number) {
  return {
    width: 62,
    height: Math.min(420, 20 + itemCount * 40 + Math.max(0, itemCount - 1) * 5),
  };
}

const popupPreparation = new Map<string, Promise<void>>();

async function ensureTauriSidebarMenuPopupPrepared(
  pluginMenus: Pick<MenuDef, "id" | "name" | "icon" | "iconType">[],
  triggerRect: DOMRect,
) {
  const [{ getCurrentWebviewWindow }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/core"),
  ]);
  const source = getCurrentWebviewWindow();
  const popupLabel = createPopupLabel(source.label);
  const payload = createPopupPayload(pluginMenus);
  const dimensions = popupDimensions(payload.items.length);
  const popupUrl = buildTauriSidebarMenuPopupUrl(source.label, popupLabel, "/");
  const query = popupUrl.includes("?") ? popupUrl.split("?", 2)[1] : "";

  localStorage.setItem(popupStorageKey(popupLabel), JSON.stringify(payload));

  let preparation = popupPreparation.get(popupLabel);
  if (!preparation) {
    preparation = (async () => {
      await invoke("prepare_sidebar_menu_window", {
        sourceLabel: source.label,
        popupLabel,
        query,
        triggerLeft: triggerRect.left,
        triggerTop: triggerRect.top,
        triggerWidth: triggerRect.width,
        triggerHeight: triggerRect.height,
        width: dimensions.width,
        height: dimensions.height,
      });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const ready = await invoke<boolean>("is_sidebar_menu_window_ready", {
          popupLabel,
        });
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out preloading native popup ${popupLabel}`);
    })().finally(() => {
      popupPreparation.delete(popupLabel);
    });
    popupPreparation.set(popupLabel, preparation);
  }

  await preparation;
  localStorage.removeItem(popupStorageKey(popupLabel));
  await source.emitTo(popupLabel, TAURI_SIDEBAR_MENU_PAYLOAD_EVENT, payload);
  return { source, popupLabel, payload, dimensions };
}

export async function toggleTauriSidebarMenuPopup(
  trigger: HTMLElement,
  pluginMenus: Pick<MenuDef, "id" | "name" | "icon" | "iconType">[],
): Promise<TauriSidebarMenuToggleResult> {
  if (!isTauriMacOSRuntime()) return "unavailable";

  const macosVersion = tauriOsVersion();
  if (!supportsTauriLiquidGlassVersion(macosVersion)) {
    console.info(
      `[TauriSidebarMenu] Native Liquid Glass popup requires macOS 26+; current version is ${macosVersion}`,
    );
    return "unavailable";
  }

  try {
    const [{ invoke }] = await Promise.all([import("@tauri-apps/api/core")]);
    const rect = trigger.getBoundingClientRect();
    const { source, popupLabel, dimensions } =
      await ensureTauriSidebarMenuPopupPrepared(pluginMenus, rect);
    return await invoke<TauriSidebarMenuToggleResult>(
      "toggle_sidebar_menu_window",
      {
        sourceLabel: source.label,
        popupLabel,
        triggerLeft: rect.left,
        triggerTop: rect.top,
        triggerWidth: rect.width,
        triggerHeight: rect.height,
        width: dimensions.width,
        height: dimensions.height,
      },
    );
  } catch (error) {
    console.warn("[TauriSidebarMenu] Failed to toggle native popup", error);
    return "unavailable";
  }
}

export async function closeTauriSidebarMenuPopup(): Promise<void> {
  if (!isTauriMacOSRuntime()) return;
  try {
    const [{ getCurrentWebviewWindow }, { invoke }] = await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/core"),
    ]);
    const source = getCurrentWebviewWindow();
    const popupLabel = createPopupLabel(source.label);
    popupPreparation.delete(popupLabel);
    localStorage.removeItem(popupStorageKey(popupLabel));
    await invoke("close_sidebar_menu_window", { popupLabel });
  } catch {
    /* popup is already gone */
  }
}

export async function listenTauriSidebarMenuActions(
  handler: (action: TauriSidebarMenuAction) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ action: TauriSidebarMenuAction }>(
    TAURI_SIDEBAR_MENU_ACTION_EVENT,
    (event) => handler(event.payload.action),
  );
}
