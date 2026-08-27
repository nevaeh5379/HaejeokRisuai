import { alertToast } from "./alert";
import {
  completeNativeChatRequest,
  showNativeChatNotification,
  usesNativeChatLifecycle,
} from "./androidChatLifecycle";
import {
  chatTabsStore,
  findChatTarget,
  openChatTargetInTab,
} from "./chatTabs.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { settingsStore } from "./stores/domain/settingsStore.svelte";

export interface ChatResponseNotificationOptions {
  chatId?: string;
  characterId?: string;
  characterName?: string;
  chatName?: string;
  result?: string;
  dedupeKey?: string;
  completeNativeLifecycle?: boolean;
}

const notifiedKeys = new Set<string>();
const MAX_DEDUPE_KEYS = 256;

function rememberNotification(key?: string): boolean {
  if (!key) return true;
  if (notifiedKeys.has(key)) return false;
  notifiedKeys.add(key);
  if (notifiedKeys.size > MAX_DEDUPE_KEYS) {
    notifiedKeys.delete(notifiedKeys.values().next().value as string);
  }
  return true;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function findLatestResponse(chatId?: string): string {
  if (!chatId) return "";
  for (const character of characterStore.characters) {
    const chat = character.chats?.find((item) => item.id === chatId);
    if (!chat) continue;
    for (let index = (chat.message?.length ?? 0) - 1; index >= 0; index--) {
      const message = chat.message[index];
      if (message?.role === "char") {
        return typeof message.data === "string" ? message.data : "";
      }
    }
    return "";
  }
  return "";
}

export async function notifyChatResponse(
  options: ChatResponseNotificationOptions,
): Promise<void> {
  const target = options.chatId ? findChatTarget(options.chatId) : null;
  const characterId = options.characterId || target?.characterId;
  const chatId = options.chatId || target?.chatId;

  if (chatId) chatTabsStore.markUnread(chatId);
  if (!settingsStore.state.notification || !rememberNotification(options.dedupeKey)) return;

  const characterName = options.characterName || target?.characterName || "RisuAI";
  const chatName = options.chatName || target?.chatName || "Chat";
  const result = options.result || findLatestResponse(chatId);
  const body = compactText(result, 320) || "Response ready";
  const title = `${characterName} · ${chatName}`;
  alertToast(`${title}: ${compactText(body, 120)}`);

  if (usesNativeChatLifecycle()) {
    if (options.completeNativeLifecycle) {
      await completeNativeChatRequest({ title, body, notify: true });
    } else {
      await showNativeChatNotification({ title, body });
    }
    return;
  }
  if (typeof Notification === "undefined") return;
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (_error) {
      return;
    }
  }
  if (permission !== "granted") return;

  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (characterId && chatId) {
        void openChatTargetInTab(characterId, chatId);
      }
    };
  } catch (_error) {}
}
