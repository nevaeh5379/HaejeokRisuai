import sendSound from "../etc/send.mp3";
import {
  completeNativeChatRequest,
  requestNativeChatNotificationPermission,
  showNativeChatNotification,
  usesNativeChatLifecycle,
} from "./androidChatLifecycle";
import { subscribeChatResponsePush } from "./network/pushSubscriptions";
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

let permissionRequestedThisSession = false;

/** @internal Test-only: resets the per-session permission prompt latch. */
export function resetChatNotificationPermissionForTests(): void {
  permissionRequestedThisSession = false;
}

/**
 * Browsers only show the notification permission prompt while handling a
 * user gesture. Response-time requests happen after the page is already
 * backgrounded, so the prompt is silently dropped. Ask at send time instead,
 * when the user is still interacting with the app.
 */
export async function ensureChatNotificationPermission(): Promise<void> {
  if (!settingsStore.state.notification || permissionRequestedThisSession)
    return;
  permissionRequestedThisSession = true;
  if (usesNativeChatLifecycle()) {
    await requestNativeChatNotificationPermission();
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") {
    // Already granted: make sure the server can reach us while backgrounded.
    await subscribeChatResponsePush();
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") await subscribeChatResponsePush();
  } catch (_error) {}
}

export async function notifyChatResponse(
  options: ChatResponseNotificationOptions,
): Promise<void> {
  const target = options.chatId ? findChatTarget(options.chatId) : null;
  const characterId = options.characterId || target?.characterId;
  const chatId = options.chatId || target?.chatId;

  if (chatId) chatTabsStore.markUnread(chatId);
  if (
    (!settingsStore.state.notification && !settingsStore.state.playMessage) ||
    !rememberNotification(options.dedupeKey)
  )
    return;

  const generationId = options.dedupeKey?.startsWith("model-job:")
    ? options.dedupeKey.slice("model-job:".length)
    : options.dedupeKey?.startsWith("local:")
      ? options.dedupeKey.slice("local:".length)
      : null;

  // The service worker may have already raised the OS notification for this
  // completion while the page was backgrounded; staying silent here prevents
  // a duplicate alarm when the user returns to the tab.
  if (await swAlreadyNotifiedChatResponse(generationId)) return;

  if (settingsStore.state.playMessage && typeof Audio !== "undefined") {
    try {
      const audio = new Audio(sendSound);
      audio.play().catch(() => {});
    } catch {}
  }

  if (!settingsStore.state.notification) return;

  const characterName =
    options.characterName || target?.characterName || "RisuAI";
  const chatName = options.chatName || target?.chatName || "Chat";
  const result = options.result || findLatestResponse(chatId);
  const body = compactText(result, 320) || "Response ready";
  const title = `${characterName} · ${chatName}`;

  // Tell the service worker this completion was already surfaced in-page so
  // a racing server push does not double-notify.
  markChatResponseHandledInSw(generationId);

  if (usesNativeChatLifecycle()) {
    if (options.completeNativeLifecycle) {
      await completeNativeChatRequest({ title, body, notify: true });
    } else {
      await showNativeChatNotification({ title, body });
    }
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

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

function markChatResponseHandledInSw(generationId: string | null): void {
  if (!generationId || typeof navigator === "undefined") return;
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "CHAT_RESPONSE_HANDLED",
      generationId,
    });
  } catch (_error) {}
}

function swAlreadyNotifiedChatResponse(
  generationId: string | null,
): Promise<boolean> {
  if (!generationId || typeof navigator === "undefined")
    return Promise.resolve(false);
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 500);
    const cleanup = () => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close?.();
    };
    channel.port1.onmessage = (event) => {
      cleanup();
      resolve(event.data?.shown === true);
    };
    try {
      controller.postMessage(
        { type: "QUERY_CHAT_RESPONSE_SHOWN", generationId },
        [channel.port2],
      );
    } catch {
      cleanup();
      resolve(false);
    }
  });
}
