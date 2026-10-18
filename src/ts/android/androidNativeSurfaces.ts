import { getCharImage } from "../characterImage";
import { resolveRecentChatActiveTarget } from "../recentChatActivity";
import type { SqlRecentChatMetadata } from "../storage/sql/ISqlStorage";
import { getSqlRuntime } from "../storage/sql/sqlRuntime";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import {
  updateAndroidRecentChatWidget,
  updateAndroidShortcuts,
  usesAndroidNativeIntegration,
} from "./androidNativeIntegration";

const SHORTCUT_LIMIT = 4;
export const DEFAULT_WIDGET_BOT_COUNT = 12;
export const MIN_WIDGET_BOT_COUNT = 1;
export const MAX_WIDGET_BOT_COUNT = 36;
const RECENT_SCAN_LIMIT = 32;
const WIDGET_ARTWORK_CACHE_MAX_ENTRIES = MAX_WIDGET_BOT_COUNT + SHORTCUT_LIMIT;

export function getAndroidWidgetBotCount(): number {
  const configured = settingsStore.state?.androidWidgetBotCount;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_WIDGET_BOT_COUNT;
  }
  return Math.max(
    MIN_WIDGET_BOT_COUNT,
    Math.min(MAX_WIDGET_BOT_COUNT, Math.floor(configured)),
  );
}
const widgetArtworkCache = new Map<string, string | null>();

function rememberWidgetArtwork(
  imageLocation: string,
  data: string | null,
): string | null {
  widgetArtworkCache.delete(imageLocation);
  widgetArtworkCache.set(imageLocation, data);
  while (widgetArtworkCache.size > WIDGET_ARTWORK_CACHE_MAX_ENTRIES) {
    const oldest = widgetArtworkCache.keys().next().value as string | undefined;
    if (!oldest) break;
    widgetArtworkCache.delete(oldest);
  }
  return data;
}

async function loadWidgetArtwork(
  imageLocation: string | null,
): Promise<string | null> {
  if (!imageLocation || typeof document === "undefined") return null;
  if (widgetArtworkCache.has(imageLocation)) {
    const cached = widgetArtworkCache.get(imageLocation) ?? null;
    return rememberWidgetArtwork(imageLocation, cached);
  }
  try {
    // Read the original character artwork. The old thumbnail path was visibly
    // soft once a widget card became larger than a tiny launcher avatar.
    const source = await getCharImage(imageLocation, "plain");
    if (!source || source === "/none.webp") return null;
    const blob = await (await fetch(source)).blob();
    const bitmap = await createImageBitmap(blob);
    // Preserve each character's own artwork ratio. Only cap the longest edge
    // so RemoteViews gets a sharp, reasonably sized bitmap instead of a
    // low-resolution thumbnail or a multi-megabyte original.
    const maxEdge = 640;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const radius = Math.max(12, Math.round(Math.min(width, height) * 0.055));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    context.beginPath();
    context.moveTo(radius, 0);
    context.lineTo(width - radius, 0);
    context.quadraticCurveTo(width, 0, width, radius);
    context.lineTo(width, height - radius);
    context.quadraticCurveTo(width, height, width - radius, height);
    context.lineTo(radius, height);
    context.quadraticCurveTo(0, height, 0, height - radius);
    context.lineTo(0, radius);
    context.quadraticCurveTo(0, 0, radius, 0);
    context.closePath();
    context.clip();
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const data = canvas.toDataURL("image/webp", 0.9);
    return rememberWidgetArtwork(imageLocation, data);
  } catch (error) {
    console.warn(
      "[NativeIntegration] Failed to prepare widget artwork:",
      error,
    );
    return rememberWidgetArtwork(imageLocation, null);
  }
}

function localRecentChats(limit: number): SqlRecentChatMetadata[] {
  const rows: SqlRecentChatMetadata[] = [];
  const activeTarget = resolveRecentChatActiveTarget(
    characterStore.characters,
    characterStore.selectedId,
  );
  for (const character of characterStore.characters) {
    if (!character?.chaId || character.trashTime) continue;
    for (let index = 0; index < (character.chats?.length ?? 0); index++) {
      const chat = character.chats[index];
      if (!chat?.id) continue;
      const lastMessage = chat.message?.at(-1);
      const ownLastDate = chat.lastDate ?? lastMessage?.time ?? null;
      const lastDate =
        chat.id === activeTarget?.chatId
          ? Math.max(ownLastDate ?? 0, activeTarget.timestamp)
          : ownLastDate;
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
    const activeTarget = resolveRecentChatActiveTarget(
      characterStore.characters,
      characterStore.selectedId,
    );
    const recent = await storage.listRecentChats(limit, activeTarget?.chatId);
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
    const widgetLimit = getAndroidWidgetBotCount();
    const scanLimit = Math.max(RECENT_SCAN_LIMIT, widgetLimit * 2);
    const recent = await loadAndroidRecentChats(scanLimit);
    const widgetChats: SqlRecentChatMetadata[] = [];
    const seenCharacters = new Set<string>();
    for (const chat of recent) {
      if (seenCharacters.has(chat.characterId)) continue;
      seenCharacters.add(chat.characterId);
      widgetChats.push(chat);
      if (widgetChats.length >= widgetLimit) break;
    }
    const widgetItems = await Promise.all(
      widgetChats.map(async (chat) => ({
        characterId: chat.characterId,
        chatId: chat.chatId,
        characterName: chat.characterName || "RisuAI",
        chatName: chat.chatName || "Chat",
        lastMessage: chat.lastMessage || "",
        iconData: await loadWidgetArtwork(chat.characterImage),
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
