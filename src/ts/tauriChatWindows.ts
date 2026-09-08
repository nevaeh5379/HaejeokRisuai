import type { ChatTab } from "./chatTabs.svelte";
import { isTauri } from "./platform";

const CHAT_WINDOW_KIND_PARAM = "risuWindow";
const CHARACTER_ID_PARAM = "characterId";
const CHAT_ID_PARAM = "chatId";
const CHAT_WINDOW_KIND = "chat";

export interface TauriChatWindowTarget {
  characterId: string;
  chatId: string;
}

export function parseTauriChatWindowTarget(
  search: string,
): TauriChatWindowTarget | null {
  const params = new URLSearchParams(search);
  if (params.get(CHAT_WINDOW_KIND_PARAM) !== CHAT_WINDOW_KIND) return null;

  const characterId = params.get(CHARACTER_ID_PARAM)?.trim();
  const chatId = params.get(CHAT_ID_PARAM)?.trim();
  if (!characterId || !chatId) return null;
  return { characterId, chatId };
}

export function buildTauriChatWindowUrl(
  target: TauriChatWindowTarget,
  pathname = "/",
): string {
  const params = new URLSearchParams({
    [CHAT_WINDOW_KIND_PARAM]: CHAT_WINDOW_KIND,
    [CHARACTER_ID_PARAM]: target.characterId,
    [CHAT_ID_PARAM]: target.chatId,
  });
  return `${pathname || "/"}?${params.toString()}`;
}

function createChatWindowLabel(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `chat-window-${Date.now().toString(36)}-${random}`;
}

export async function openChatInNewTauriWindow(
  tab: Pick<ChatTab, "characterId" | "chatId">,
  title = "RisuAI",
): Promise<boolean> {
  if (!isTauri) return false;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const child = new WebviewWindow(createChatWindowLabel(), {
    url: buildTauriChatWindowUrl(tab, location.pathname),
    title,
    width: Math.max(720, Math.min(window.innerWidth, 1280)),
    height: Math.max(600, Math.min(window.innerHeight, 960)),
    minWidth: 300,
    minHeight: 500,
    resizable: true,
    focus: true,
  });

  return new Promise<boolean>((resolve, reject) => {
    void child.once("tauri://created", () => resolve(true));
    void child.once("tauri://error", (event) => {
      reject(
        new Error(`Failed to create chat window: ${String(event.payload)}`),
      );
    });
  });
}

export async function restoreTauriChatWindowTarget(
  search = location.search,
): Promise<boolean> {
  if (!isTauri) return false;
  const target = parseTauriChatWindowTarget(search);
  if (!target) return false;

  const { openChatTargetInTab } = await import("./chatTabs.svelte");
  return openChatTargetInTab(target.characterId, target.chatId);
}
