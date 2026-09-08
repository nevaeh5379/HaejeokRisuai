import { get } from "svelte/store";
import { isTauri } from "./platform";
import {
  MobileGUI,
  MobileSideBar,
  SettingsMenuIndex,
  openMobileSettingsPage,
  selectedCharID,
  settingsOpen,
} from "./stores.svelte";
import { MAIN_CHAT_WORKSPACE_WINDOW_ID } from "./chatWorkspace";
import { getCurrentChatWorkspaceWindowId } from "./tauriChatWindows";

export const TAURI_APP_MENU_EVENT = "risu://app-menu";

export type TauriAppMenuCommand =
  | "risu.bots.settings"
  | "risu.bots.personas"
  | "risu.bots.lorebook"
  | "risu.bots.prompts"
  | "risu.modules.settings"
  | "risu.modules.plugins"
  | "risu.tools.settings"
  | "risu.tools.advanced"
  | "risu.tools.hotkeys"
  | "risu.tools.account-files";

export function settingsIndexForTauriAppMenuCommand(
  command: string,
): number | null {
  switch (command as TauriAppMenuCommand) {
    case "risu.bots.settings":
    case "risu.tools.settings":
      return 1;
    case "risu.bots.personas":
      return 12;
    case "risu.bots.lorebook":
      return 8;
    case "risu.bots.prompts":
      return 13;
    case "risu.modules.settings":
      return 14;
    case "risu.modules.plugins":
      return 4;
    case "risu.tools.advanced":
      return 6;
    case "risu.tools.hotkeys":
      return 15;
    case "risu.tools.account-files":
      return 0;
    default:
      return null;
  }
}

export function openTauriAppMenuCommand(command: string): boolean {
  const menuIndex = settingsIndexForTauriAppMenuCommand(command);
  if (menuIndex === null) return false;
  if (get(MobileGUI)) {
    openMobileSettingsPage(menuIndex, get(selectedCharID), get(MobileSideBar));
  } else {
    SettingsMenuIndex.set(menuIndex);
    settingsOpen.set(true);
  }
  return true;
}

let appMenuCleanup: (() => void) | null = null;

export async function initializeTauriAppMenu(): Promise<void> {
  if (
    !isTauri ||
    appMenuCleanup ||
    getCurrentChatWorkspaceWindowId() !== MAIN_CHAT_WORKSPACE_WINDOW_ID
  ) {
    return;
  }
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  appMenuCleanup = await getCurrentWebviewWindow().listen<string>(
    TAURI_APP_MENU_EVENT,
    (event) => {
      if (!openTauriAppMenuCommand(event.payload)) {
        console.warn("[TauriAppMenu] Unknown menu command", event.payload);
      }
    },
  );
}
