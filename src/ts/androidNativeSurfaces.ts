import { getCharImage } from "./characterImage";
import type { SqlRecentChatMetadata } from "./storage/sql/ISqlStorage";
import { getSqlRuntime } from "./storage/sql/sqlRuntime";
import { characterStore } from "./stores/domain/characterStore.svelte";
import {
  updateAndroidRecentChatWidget,
  updateAndroidShortcuts,
  usesAndroidNativeIntegration,
} from "./androidNativeIntegration";

const SHORTCUT_LIMIT = 4;
const WIDGET_LIMIT = 8;
const RECENT_SCAN_LIMIT = 32;
const widgetIconCache = new Map<string, string | null>();

async function loadWidgetIcon(
  imageLocation: string | null,
): Promise<string | null> {
  if (!imageLocation || typeof document === "undefined") return null;
  if (widgetIconCache.has(imageLocation))
    return widgetIconCache.get(imageLocation) ?? null;
  try {
    const source = await getCharImage(imageLocation, "plain", {
      thumbnail: true,
    });
    if (!source || source === "/none.webp") return null;
    const blob = await (await fetch(source)).blob();
    const bitmap = await createImageBitmap(blob);
    const size = 112;
    const radius = 18;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;

    // Widgets mirror the spacious character cards instead of tiny circular
    // launcher-style avatars. Bake rounded corners into the bitmap because
    // RemoteViews cannot reliably clip ImageViews on every supported API.
    context.beginPath();
    context.moveTo(radius, 0);
    context.lineTo(size - radius, 0);
    context.quadraticCurveTo(size, 0, size, radius);
    context.lineTo(size, size - radius);
    context.quadraticCurveTo(size, size, size - radius, size);
    context.lineTo(radius, size);
    context.quadraticCurveTo(0, size, 0, size - radius);
    context.lineTo(0, radius);
    context.quadraticCurveTo(0, 0, radius, 0);
    context.closePath();
    context.clip();

    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (size - width) / 2,
      (size - height) / 2,
      width,
      height,
    );
    bitmap.close();
    const data = canvas.toDataURL("image/webp", 0.82);
    widgetIconCache.set(imageLocation, data);
    return data;
  } catch (error) {
    console.warn("[NativeIntegration] Failed to prepare widget icon:", error);
    widgetIconCache.set(imageLocation, null);
    return null;
  }
}

function localRecentChats(limit: number): SqlRecentChatMetadata[] {
  const rows: SqlRecentChatMetadata[] = [];
  for (const character of characterStore.characters) {
    if (!character?.chaId || character.trashTime) continue;
    for (let index = 0; index < (character.chats?.length ?? 0); index++) {
      const chat = character.chats[index];
      if (!chat?.id) continue;
      const lastMessage = chat.message?.at(-1);
      const lastDate = chat.lastDate ?? lastMessage?.time ?? null;
      rows.push({
        characterId: character.chaId,
        characterName: character.name || "RisuAI",
        characterImage: character.image ?? null,
        characterType: character.type === "group" ? "group" : "character",
        chatId: chat.id,
        chatPosition: index,
        chatName: chat.name || `Chat ${index + 1}`,
        folderId: chat.folderId ?? null,
        lastDate,
        lastMessage:
          typeof lastMessage?.data === "string" ? lastMessage.data : "",
      });
    }
  }
  return rows
    .sort((left, right) => (right.lastDate ?? 0) - (left.lastDate ?? 0))
    .slice(0, limit);
}

export async function loadAndroidRecentChats(
  limit = SHORTCUT_LIMIT,
): Promise<SqlRecentChatMetadata[]> {
  const storage = getSqlRuntime().storage;
  if (!storage?.listRecentChats) return localRecentChats(limit);
  try {
    const recent = await storage.listRecentChats(
      limit,
      characterStore.currentChat?.id,
    );
    return recent.length > 0 ? recent : localRecentChats(limit);
  } catch (error) {
    console.warn("[NativeIntegration] Recent chat query failed:", error);
    return localRecentChats(limit);
  }
}

let refreshPromise: Promise<void> | null = null;

export function refreshAndroidNativeSurfaces(): Promise<void> {
  if (!usesAndroidNativeIntegration()) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const recent = await loadAndroidRecentChats(RECENT_SCAN_LIMIT);
    const widgetChats: SqlRecentChatMetadata[] = [];
    const seenCharacters = new Set<string>();
    for (const chat of recent) {
      if (seenCharacters.has(chat.characterId)) continue;
      seenCharacters.add(chat.characterId);
      widgetChats.push(chat);
      if (widgetChats.length >= WIDGET_LIMIT) break;
    }
    const widgetItems = await Promise.all(
      widgetChats.map(async (chat) => ({
        characterId: chat.characterId,
        chatId: chat.chatId,
        characterName: chat.characterName || "RisuAI",
        chatName: chat.chatName || "Chat",
        lastMessage: chat.lastMessage || "",
        iconData: await loadWidgetIcon(chat.characterImage),
      })),
    );
    await Promise.all([
      updateAndroidShortcuts(
        recent.slice(0, SHORTCUT_LIMIT).map((chat) => ({
          characterId: chat.characterId,
          chatId: chat.chatId,
          label: chat.characterName || chat.chatName || "RisuAI",
        })),
      ),
      updateAndroidRecentChatWidget(widgetItems),
    ]);
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
