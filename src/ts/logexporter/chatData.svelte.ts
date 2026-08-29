import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { get } from "svelte/store";
import { selectedCharID } from "src/ts/stores.svelte";
import type { character, groupChat, Message } from "../storage/database/schema";
import { preLoadChat } from "src/ts/process/coldstorage.svelte";
import { ParseMarkdown } from "src/ts/parser/parser.svelte";
import { getFileSrc } from "src/ts/globalApi.svelte";
import { findCharacterbyId, getUserName, getUserIcon } from "src/ts/util";
import type {
  CharInfo,
  LogExportData,
  LogMessageData,
  MessageRangeOptions,
} from "./types";

/**
 * Native chat data collection for the Log Exporter.
 *
 * Replaces the plugin's host-DOM snapshot approach: chat messages are read
 * directly from RisuAI stores and rendered through the same ParseMarkdown
 * pipeline used by the chat screen, so custom scripts, assets and regex
 * formats all resolve identically to what the user sees.
 */

function isGroup(char: character | groupChat | undefined): char is groupChat {
  return char?.type === "group";
}

/** Resolves the display name of a message's author. */
function resolveSpeakerName(msg: Message, char: character | groupChat): string {
  if (msg.role === "user") {
    return msg.name || getUserName();
  }
  if (msg.saying) {
    try {
      return findCharacterbyId(msg.saying)?.name || char.name;
    } catch {
      return char.name;
    }
  }
  return char.name;
}

async function resolveAvatar(url: string | undefined): Promise<string> {
  if (!url) return "";
  try {
    return (await getFileSrc(url)) ?? "";
  } catch {
    return url;
  }
}

function getFirstMessageText(
  char: character | groupChat,
  chat: { fmIndex?: number },
): string {
  if (isGroup(char)) return "";
  const fmIndex = chat.fmIndex ?? -1;
  const raw =
    fmIndex === -1
      ? char.firstMessage
      : (char.alternateGreetings?.[fmIndex] ?? char.firstMessage);
  return raw ?? "";
}

function isBlankMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === "{{none}}" || trimmed === "{{blank}}";
}

export interface CollectLogDataOptions extends MessageRangeOptions {
  /** Character index (defaults to the currently selected one) */
  characterIndex?: number;
  /** Chat index inside the character (defaults to the active page) */
  chatIndex?: number;
  /** Abort signal support via a cancelled flag holder */
  isCancelled?: { value: boolean };
}

/**
 * Loads and renders the current (or specified) chat into export-ready data.
 */
export async function collectLogData(
  options: CollectLogDataOptions = {},
): Promise<LogExportData> {
  const cancelled = options.isCancelled;

  const selId = options.characterIndex ?? get(selectedCharID);
  const char = characterStore.characters[selId];
  if (!char) throw new Error("No character selected");

  const chatPage = options.chatIndex ?? char.chatPage ?? 0;
  // Ensure every message is hydrated before exporting
  await preLoadChat(selId, chatPage, { full: true });
  if (cancelled?.value) throw new Error("cancelled");

  const chat = char.chats?.[chatPage];
  if (!chat) throw new Error("No chat available");

  const charAvatarUrl = await resolveAvatar(char.image);
  const userIconUrl = await resolveAvatar(getUserIcon());

  const avatarCache = new Map<string, string>();

  const firstMessageText = getFirstMessageText(char, chat);
  const hasFirstMessage = !isGroup(char) && !isBlankMessage(firstMessageText);

  interface RawItem {
    msg: Message;
    isFirstMessage: boolean;
    chatIndex: number;
  }

  const allRawItems: RawItem[] = [];
  if (hasFirstMessage) {
    allRawItems.push({
      msg: {
        role: "char",
        data: firstMessageText,
        name: char.name,
        chatId: "first-message",
      },
      isFirstMessage: true,
      chatIndex: -1,
    });
  }

  const chatMessages = chat.message ?? [];
  for (let i = 0; i < chatMessages.length; i++) {
    allRawItems.push({
      msg: chatMessages[i],
      isFirstMessage: false,
      chatIndex: i,
    });
  }

  let rawItems = allRawItems;
  if (options.singleMessage !== undefined) {
    if (options.singleMessage === -1) {
      rawItems = allRawItems.filter((item) => item.isFirstMessage);
    } else {
      const matched = allRawItems.filter(
        (item) =>
          !item.isFirstMessage && item.chatIndex === options.singleMessage,
      );
      if (matched.length > 0) {
        rawItems = matched;
      } else if (
        options.singleMessage >= 0 &&
        options.singleMessage < allRawItems.length
      ) {
        rawItems = [allRawItems[options.singleMessage]];
      } else {
        rawItems = [];
      }
    }
  } else if (
    options.startIndex !== undefined ||
    options.endIndex !== undefined
  ) {
    const startChatIdx = options.startIndex ?? -1;
    const endChatIdx = options.endIndex;

    rawItems = allRawItems.filter((item) => {
      if (startChatIdx !== undefined) {
        if (startChatIdx === -1) {
          // Starts from first message, include all
        } else {
          if (item.isFirstMessage) return false;
          if (item.chatIndex < startChatIdx) return false;
        }
      }
      if (endChatIdx !== undefined) {
        if (endChatIdx === -1) {
          if (!item.isFirstMessage) return false;
        } else {
          if (!item.isFirstMessage && item.chatIndex > endChatIdx) return false;
        }
      }
      return true;
    });
  }

  const participants = new Set<string>();

  const messages: LogMessageData[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    if (cancelled?.value) throw new Error("cancelled");
    const item = rawItems[i];
    const msg = item.msg;
    const isFm = item.isFirstMessage;
    const chatID = isFm ? -1 : item.chatIndex;
    const cbsConditions = {
      firstmsg: isFm,
      chatRole: msg.role,
    };

    const name = resolveSpeakerName(msg, char);
    participants.add(name);

    // Avatar resolution (per speaker)
    let avatarUrl = "";
    if (msg.role === "user") {
      avatarUrl = userIconUrl;
    } else {
      const sayingId = msg.saying;
      if (sayingId && avatarCache.has(sayingId)) {
        avatarUrl = avatarCache.get(sayingId)!;
      } else if (sayingId) {
        const said = findCharacterbyId(sayingId);
        avatarUrl = await resolveAvatar(said?.image);
        avatarCache.set(sayingId, avatarUrl);
      } else if (isGroup(char)) {
        avatarUrl = await resolveAvatar(char.image);
      } else {
        avatarUrl = charAvatarUrl;
      }
    }

    // Render through the native parser pipeline ('notrim' keeps full HTML)
    let html = "";
    try {
      html = await ParseMarkdown(
        msg.data ?? "",
        char,
        "notrim",
        chatID,
        cbsConditions,
      );
    } catch (e) {
      console.error("[logexporter] ParseMarkdown failed:", e);
      html = `<p>${escapeHtml(msg.data ?? "")}</p>`;
    }

    messages.push({
      key: isFm
        ? `${chat.id ?? chatPage}-fm`
        : `${chat.id ?? chatPage}-${item.chatIndex}`,
      role: msg.role as "user" | "char",
      name,
      html,
      text: htmlToText(html),
      time: msg.time,
      isUser: msg.role === "user",
      avatarUrl,
      rawMessage: msg,
    });

    if (msg.role === "char" && !avatarUrl && !isGroup(char)) {
      // fall back handled at render time with initials placeholder
    }
  }

  const chatName = chat.name || `Chat ${chatPage}`;
  const charInfo: CharInfo = {
    name: char.name,
    chatName,
    avatarUrl: charAvatarUrl,
  };

  return {
    charInfo,
    messages,
    participants,
    characterId: char.chaId ?? "",
    character: char,
  };
}

/** Strips tags from parsed HTML for plain-text exports. */
export function htmlToText(html: string): string {
  try {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.querySelectorAll("button").forEach((b) => b.remove());
    return (container.textContent ?? "").trim();
  } catch {
    return html.replace(/<[^>]*>/g, "");
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
