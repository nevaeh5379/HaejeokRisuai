import { get } from "svelte/store";
import { isTauri } from "./platform";
import {
  MobileGUI,
  MobileSideBar,
  ReloadGUIPointer,
  SettingsMenuIndex,
  openMobileSettingsPage,
  selectedCharID,
  settingsOpen,
} from "./stores.svelte";
import {
  MAIN_CHAT_WORKSPACE_WINDOW_ID,
  type ChatWorkspaceSnapshot,
} from "./chatWorkspace";
import {
  getCurrentChatWorkspaceWindowId,
  getTauriChatWindowManager,
} from "./tauriChatWindows";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { getSqlRuntime } from "./storage/sql/sqlRuntime";

export const TAURI_APP_MENU_EVENT = "risu://app-menu";
export const TAURI_APP_MENU_ACTIVATE_TAB_EVENT = "risu://app-menu-activate-tab";
export const TAURI_APP_MENU_WORKSPACE_REFRESH_EVENT =
  "risu:workspace-menu-refresh";
const RECENT_MENU_LIMIT = 12;

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

export interface TauriAppMenuEntry {
  id: string;
  label: string;
}

export interface TauriNavigationMenuModel {
  openTabs: TauriAppMenuEntry[];
  recentChats: TauriAppMenuEntry[];
  recentBots: TauriAppMenuEntry[];
}

export interface TauriRecentChatMenuSource {
  characterId: string;
  characterName: string;
  chatId: string;
  chatName: string;
  timestamp: number;
}

export interface TauriMenuCharacterSource {
  chaId: string;
  name?: string;
  trashTime?: number;
  lastInteraction?: number;
  chatPage?: number;
  chats?: Array<{
    id?: string;
    name?: string;
    lastDate?: number;
    message?: Array<{ time?: number }>;
  }>;
}

export type TauriNavigationCommand =
  | { kind: "tab"; windowId: string; tabId: string }
  | { kind: "chat"; characterId: string; chatId: string }
  | { kind: "bot"; characterId: string };

function encodeCommandPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeCommandPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseTauriNavigationCommand(
  command: string,
): TauriNavigationCommand | null {
  const parts = command.split(":");
  if (parts[0] === "risu.nav.tab" && parts.length === 3) {
    const windowId = decodeCommandPart(parts[1]);
    const tabId = decodeCommandPart(parts[2]);
    return windowId && tabId ? { kind: "tab", windowId, tabId } : null;
  }
  if (parts[0] === "risu.nav.chat" && parts.length === 3) {
    const characterId = decodeCommandPart(parts[1]);
    const chatId = decodeCommandPart(parts[2]);
    return characterId && chatId ? { kind: "chat", characterId, chatId } : null;
  }
  if (parts[0] === "risu.nav.bot" && parts.length === 2) {
    const characterId = decodeCommandPart(parts[1]);
    return characterId ? { kind: "bot", characterId } : null;
  }
  return null;
}

function characterRecency(character: TauriMenuCharacterSource): number {
  let recent = character.lastInteraction ?? 0;
  for (const chat of character.chats ?? []) {
    recent = Math.max(recent, chat.lastDate ?? chat.message?.at(-1)?.time ?? 0);
  }
  return recent;
}

export function buildTauriNavigationMenuModel(
  workspace: ChatWorkspaceSnapshot,
  characters: readonly TauriMenuCharacterSource[],
  recentChats: readonly TauriRecentChatMenuSource[],
  recentLimit = RECENT_MENU_LIMIT,
): TauriNavigationMenuModel {
  const characterById = new Map(
    characters.map((character) => [character.chaId, character]),
  );
  const duplicateTargets = new Map<string, number>();
  for (const window of workspace.windows) {
    for (const tab of window.tabs.tabs) {
      const key = `${tab.characterId}\u0000${tab.chatId}`;
      duplicateTargets.set(key, (duplicateTargets.get(key) ?? 0) + 1);
    }
  }
  const auxiliaryIds = workspace.windows
    .filter((window) => window.id !== MAIN_CHAT_WORKSPACE_WINDOW_ID)
    .map((window) => window.id);
  const openTabs: TauriAppMenuEntry[] = [];
  for (const window of workspace.windows) {
    for (const tab of window.tabs.tabs) {
      const character = characterById.get(tab.characterId);
      const chatIndex =
        character?.chats?.findIndex((chat) => chat.id === tab.chatId) ?? -1;
      const chat = chatIndex >= 0 ? character?.chats?.[chatIndex] : undefined;
      const characterName = character?.name || "Unknown Bot";
      const chatName =
        chat?.name || (chatIndex >= 0 ? `Chat ${chatIndex + 1}` : "Chat");
      const targetKey = `${tab.characterId}\u0000${tab.chatId}`;
      let label = `${characterName} — ${chatName}`;
      if ((duplicateTargets.get(targetKey) ?? 0) > 1) {
        const windowLabel =
          window.id === MAIN_CHAT_WORKSPACE_WINDOW_ID
            ? "Main"
            : `Window ${auxiliaryIds.indexOf(window.id) + 2}`;
        label += ` (${windowLabel})`;
      }
      openTabs.push({
        id: `risu.nav.tab:${encodeCommandPart(window.id)}:${encodeCommandPart(tab.id)}`,
        label,
      });
    }
  }

  const boundedRecentChats = recentChats
    .slice(0, Math.max(0, recentLimit))
    .map((chat) => ({
      id: `risu.nav.chat:${encodeCommandPart(chat.characterId)}:${encodeCommandPart(chat.chatId)}`,
      label: `${chat.characterName || "Unknown Bot"} — ${chat.chatName || "Chat"}`,
    }));

  const recentBots = characters
    .filter((character) => character.chaId && !character.trashTime)
    .map((character) => ({ character, timestamp: characterRecency(character) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, recentLimit))
    .map(({ character }) => ({
      id: `risu.nav.bot:${encodeCommandPart(character.chaId)}`,
      label: character.name || "Unknown Bot",
    }));

  return { openTabs, recentChats: boundedRecentChats, recentBots };
}

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

function openSettingsMenuCommand(command: string): boolean {
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

async function activateWorkspaceTab(
  windowId: string,
  tabId: string,
): Promise<boolean> {
  if (windowId === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    const { navigateToChatTab } = await import("./chatTabs.svelte");
    settingsOpen.set(false);
    return navigateToChatTab(tabId);
  }
  const [{ getAllWebviewWindows }, { getCurrentWebviewWindow }] =
    await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/webviewWindow"),
    ]);
  const target = (await getAllWebviewWindows()).find(
    (window) => window.label === windowId,
  );
  if (!target) return false;
  await target.setFocus();
  await getCurrentWebviewWindow().emitTo(
    windowId,
    TAURI_APP_MENU_ACTIVATE_TAB_EVENT,
    tabId,
  );
  return true;
}

async function openRecentChat(
  characterId: string,
  chatId: string,
): Promise<boolean> {
  settingsOpen.set(false);
  const { openChatTargetInTab } = await import("./chatTabs.svelte");
  return openChatTargetInTab(characterId, chatId);
}

async function openRecentBot(characterId: string): Promise<boolean> {
  const character = characterStore.characters.find(
    (item) => item.chaId === characterId,
  );
  if (!character) return false;
  const chat =
    character.chats?.[character.chatPage ?? 0] ??
    character.chats?.find((item) => item?.id);
  if (!chat?.id) return false;
  return openRecentChat(characterId, chat.id);
}

export async function openTauriAppMenuCommand(
  command: string,
): Promise<boolean> {
  const navigation = parseTauriNavigationCommand(command);
  if (navigation?.kind === "tab")
    return activateWorkspaceTab(navigation.windowId, navigation.tabId);
  if (navigation?.kind === "chat")
    return openRecentChat(navigation.characterId, navigation.chatId);
  if (navigation?.kind === "bot") return openRecentBot(navigation.characterId);
  return openSettingsMenuCommand(command);
}

function localRecentChats(limit: number): TauriRecentChatMenuSource[] {
  const sessions: TauriRecentChatMenuSource[] = [];
  for (const character of characterStore.characters) {
    if (!character || character.trashTime) continue;
    for (let index = 0; index < (character.chats?.length ?? 0); index++) {
      const chat = character.chats[index];
      if (!chat?.id) continue;
      const lastMessageTime = chat.message?.at(-1)?.time ?? 0;
      const chatTime = chat.lastDate ?? lastMessageTime;
      sessions.push({
        characterId: character.chaId,
        characterName: character.name || "Unknown Bot",
        chatId: chat.id,
        chatName: chat.name || `Chat ${index + 1}`,
        timestamp:
          index === (character.chatPage ?? 0)
            ? Math.max(chatTime, character.lastInteraction ?? 0)
            : chatTime,
      });
    }
  }
  return sessions.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

async function loadRecentChats(
  limit: number,
): Promise<TauriRecentChatMenuSource[]> {
  const storage = getSqlRuntime().storage;
  if (!storage?.listRecentChats) return localRecentChats(limit);
  const activeChatId = characterStore.currentChat?.id;
  try {
    const rows = await storage.listRecentChats(limit, activeChatId);
    return rows.map((row) => ({
      characterId: row.characterId,
      characterName: row.characterName || "Unknown Bot",
      chatId: row.chatId,
      chatName: row.chatName || `Chat ${row.chatPosition + 1}`,
      timestamp: row.lastDate ?? 0,
    }));
  } catch (error) {
    console.warn("[TauriAppMenu] Recent chat query failed", error);
    return localRecentChats(limit);
  }
}

let lastNavigationMenuSignature = "";
let navigationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let navigationRefreshSequence = 0;

export async function refreshTauriNavigationMenu(): Promise<void> {
  if (
    !isTauri ||
    getCurrentChatWorkspaceWindowId() !== MAIN_CHAT_WORKSPACE_WINDOW_ID
  )
    return;
  const sequence = ++navigationRefreshSequence;
  const recentChats = await loadRecentChats(RECENT_MENU_LIMIT);
  if (sequence !== navigationRefreshSequence) return;
  const model = buildTauriNavigationMenuModel(
    getTauriChatWindowManager().snapshot(),
    characterStore.characters,
    recentChats,
  );
  const signature = JSON.stringify(model);
  if (signature === lastNavigationMenuSignature) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("update_app_navigation_menu", { model });
  lastNavigationMenuSignature = signature;
}

export function scheduleTauriNavigationMenuRefresh(delayMs = 80): void {
  if (
    !isTauri ||
    getCurrentChatWorkspaceWindowId() !== MAIN_CHAT_WORKSPACE_WINDOW_ID
  )
    return;
  if (navigationRefreshTimer) clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    navigationRefreshTimer = null;
    void refreshTauriNavigationMenu().catch((error) => {
      console.warn("[TauriAppMenu] Failed to refresh navigation menu", error);
    });
  }, delayMs);
}

let activateTabCleanup: (() => void) | null = null;
let mainAppMenuCleanup: (() => void) | null = null;
let mainRefreshSubscriptionsReady = false;

export async function initializeTauriAppMenu(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();

  if (!activateTabCleanup) {
    activateTabCleanup = await current.listen<string>(
      TAURI_APP_MENU_ACTIVATE_TAB_EVENT,
      (event) => {
        void import("./chatTabs.svelte").then(({ navigateToChatTab }) =>
          navigateToChatTab(event.payload),
        );
      },
    );
  }

  if (getCurrentChatWorkspaceWindowId() !== MAIN_CHAT_WORKSPACE_WINDOW_ID)
    return;
  if (!mainAppMenuCleanup) {
    mainAppMenuCleanup = await current.listen<string>(
      TAURI_APP_MENU_EVENT,
      (event) => {
        void openTauriAppMenuCommand(event.payload).then((handled) => {
          if (!handled)
            console.warn("[TauriAppMenu] Unknown menu command", event.payload);
        });
      },
    );
  }
  if (!mainRefreshSubscriptionsReady) {
    mainRefreshSubscriptionsReady = true;
    ReloadGUIPointer.subscribe(() => scheduleTauriNavigationMenuRefresh());
    window.addEventListener(TAURI_APP_MENU_WORKSPACE_REFRESH_EVENT, () => {
      scheduleTauriNavigationMenuRefresh();
    });
  }
  scheduleTauriNavigationMenuRefresh(0);
}
