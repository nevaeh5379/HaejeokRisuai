import type { SqlRecentChatMetadata } from "./storage/sql/ISqlStorage";
import { getSqlRuntime } from "./storage/sql/sqlRuntime";
import { characterStore } from "./stores/domain/characterStore.svelte";
import {
  updateAndroidShortcuts,
  usesAndroidNativeIntegration,
} from "./androidNativeIntegration";

const SHORTCUT_LIMIT = 4;

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
        lastMessage: typeof lastMessage?.data === "string" ? lastMessage.data : "",
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
    return await storage.listRecentChats(limit, characterStore.currentChat?.id);
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
    const recent = await loadAndroidRecentChats(SHORTCUT_LIMIT);
    await updateAndroidShortcuts(
      recent.map((chat) => ({
        characterId: chat.characterId,
        chatId: chat.chatId,
        label: chat.characterName || chat.chatName || "RisuAI",
      })),
    );
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
