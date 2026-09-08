import type { MenuDef } from "./stores.svelte";
import { isTauriMacOS } from "./platform";

const SIDEBAR_MENU_KIND_PARAM = "risuWindow";
const SIDEBAR_MENU_KIND = "sidebar-menu";
const SOURCE_WINDOW_PARAM = "sourceWindowLabel";
const POPUP_WINDOW_PARAM = "popupWindowLabel";
const POPUP_LABEL_PREFIX = "sidebar-menu-";
const POPUP_STORAGE_PREFIX = "risu:sidebar-menu-popup:";

export const TAURI_SIDEBAR_MENU_ACTION_EVENT = "risu://sidebar-menu-action";

export type TauriSidebarMenuBuiltinIcon =
  | "settings"
  | "home"
  | "playground"
  | "search"
  | "grid";

export type TauriSidebarMenuAction =
  | TauriSidebarMenuBuiltinIcon
  | `plugin:${string}`;

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

export type TauriSidebarMenuToggleResult =
  | "opened"
  | "closed"
  | "unavailable";

let activePopup: { label: string; close(): Promise<void> } | null = null;

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
    { action: "settings", name: "Settings", iconType: "builtin", icon: "settings" },
    { action: "home", name: "Home", iconType: "builtin", icon: "home" },
    { action: "playground", name: "Playground", iconType: "builtin", icon: "playground" },
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

  const triggerCenterX = innerX + input.triggerRect.left + input.triggerRect.width / 2;
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
  const safeSource = sourceWindowLabel.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 32);
  return `${POPUP_LABEL_PREFIX}${safeSource}-${Date.now().toString(36)}`;
}

export async function toggleTauriSidebarMenuPopup(
  trigger: HTMLElement,
  pluginMenus: Pick<MenuDef, "id" | "name" | "icon" | "iconType">[],
): Promise<TauriSidebarMenuToggleResult> {
  if (
    !isTauriMacOS ||
    !document.documentElement.classList.contains("tauri-macos-liquid-glass")
  ) {
    return "unavailable";
  }

  if (activePopup) {
    const popup = activePopup;
    activePopup = null;
    try {
      await popup.close();
    } catch {
      /* already closed */
    }
    return "closed";
  }

  try {
    const [{ WebviewWindow, getCurrentWebviewWindow }, windowApi] =
      await Promise.all([
        import("@tauri-apps/api/webviewWindow"),
        import("@tauri-apps/api/window"),
      ]);
    const source = getCurrentWebviewWindow();
    const rect = trigger.getBoundingClientRect();
    const [innerPosition, sourceScaleFactor] = await Promise.all([
      source.innerPosition(),
      source.scaleFactor(),
    ]);
    const triggerCenterPhysical = {
      x: innerPosition.x + (rect.left + rect.width / 2) * sourceScaleFactor,
      y: innerPosition.y + (rect.top + rect.height / 2) * sourceScaleFactor,
    };
    const monitor = await windowApi.monitorFromPoint(
      triggerCenterPhysical.x,
      triggerCenterPhysical.y,
    );
    if (!monitor) return "unavailable";

    const items = createTauriSidebarMenuItems(pluginMenus);
    const popupWidth = 62;
    const popupHeight = Math.min(420, 20 + items.length * 40 + Math.max(0, items.length - 1) * 5);
    const placement = calculateTauriSidebarMenuPlacement({
      sourceInnerPosition: innerPosition,
      sourceScaleFactor,
      triggerRect: rect,
      popupWidth,
      popupHeight,
      workAreaPosition: monitor.workArea.position,
      workAreaSize: monitor.workArea.size,
      workAreaScaleFactor: monitor.scaleFactor,
    });
    const popupWindowLabel = createPopupLabel(source.label);
    const payload: TauriSidebarMenuPopupPayload = {
      items,
      theme: {
        textColor: readThemeColor("--risu-theme-textcolor", "#f5f5f5"),
        selectedColor: readThemeColor("--risu-theme-selected", "#44475a"),
        darkBg: readThemeColor("--risu-theme-darkbg", "#21222c"),
      },
    };
    localStorage.setItem(popupStorageKey(popupWindowLabel), JSON.stringify(payload));

    const popup = new WebviewWindow(popupWindowLabel, {
      url: buildTauriSidebarMenuPopupUrl(
        source.label,
        popupWindowLabel,
        location.pathname,
      ),
      title: "RisuAI Menu",
      x: placement.x,
      y: placement.y,
      width: popupWidth,
      height: popupHeight,
      minWidth: popupWidth,
      minHeight: Math.min(popupHeight, 100),
      maxWidth: popupWidth,
      maxHeight: popupHeight,
      resizable: false,
      decorations: false,
      transparent: true,
      shadow: true,
      skipTaskbar: true,
      focus: true,
      focusable: true,
      visible: true,
      parent: source,
    });
    activePopup = popup;

    void popup.once("tauri://destroyed", () => {
      if (activePopup?.label === popupWindowLabel) activePopup = null;
    });
    void popup.once("tauri://error", () => {
      localStorage.removeItem(popupStorageKey(popupWindowLabel));
      if (activePopup?.label === popupWindowLabel) activePopup = null;
    });
    return "opened";
  } catch (error) {
    console.warn("[TauriSidebarMenu] Failed to open native popup", error);
    return "unavailable";
  }
}

export async function closeTauriSidebarMenuPopup(): Promise<void> {
  if (!activePopup) return;
  const popup = activePopup;
  activePopup = null;
  try {
    await popup.close();
  } catch {
    /* already closed */
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
