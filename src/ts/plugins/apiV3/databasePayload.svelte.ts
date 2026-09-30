import type { character, groupChat, Chat } from "../../storage/database/schema";

type Character = character | groupChat;
type ChatMetadata = Omit<Chat, "message" | "btwSessions" | "branchState">;
type CharacterMetadata = Omit<Character, "chats"> & { chats: ChatMetadata[] };

export async function snapshotPluginDatabase(
  database: Record<string, any>,
  allowedKeys: string[],
  loadPlugins: () => Promise<unknown>,
  includeOnly: string[] | "all" = "all",
  metadataOnly = false,
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const key of allowedKeys) {
    if (includeOnly !== "all" && !includeOnly.includes(key)) continue;
    result[key] =
      key === "characters" && metadataOnly
        ? snapshotDatabaseCharacters(database[key])
        : key === "plugins"
          ? $state.snapshot(await loadPlugins())
          : $state.snapshot(database[key]);
  }
  return result;
}

// Project before snapshotting: copying first would still traverse every message.
export function snapshotDatabaseCharacters(
  characters: Character[],
): CharacterMetadata[] {
  return characters.map((character) => {
    const metadata: Record<string, unknown> = {};
    for (const key of Object.keys(character)) {
      if (key !== "chats") metadata[key] = character[key];
    }
    metadata.chats = (character.chats ?? []).map((chat) => {
      const metadata: Record<string, unknown> = {};
      for (const key of Object.keys(chat)) {
        if (key !== "message" && key !== "btwSessions" && key !== "branchState")
          metadata[key] = chat[key];
      }
      return metadata;
    });
    return $state.snapshot(metadata) as unknown as CharacterMetadata;
  });
}

// Used only by the opt-in metadata setter; legacy setters retain their semantics.
export function restoreDatabaseChatHistory(
  database: any,
  current: Character[],
): any {
  if (!Array.isArray(database?.characters)) return database;
  const byId = new Map(
    current.map((character) => [character.chaId, character]),
  );
  return {
    ...database,
    characters: database.characters.map((character: any) => {
      const existing = byId.get(character.chaId);
      const chatsById = new Map(
        (existing?.chats ?? []).map((chat) => [chat.id, chat]),
      );
      return {
        ...character,
        chats: (character.chats ?? []).map((chat: any) => {
          const existingChat = chat.id ? chatsById.get(chat.id) : undefined;
          if (Object.hasOwn(chat, "message")) return chat;
          if (!existingChat)
            throw new Error(
              "Chat metadata requires an existing chat ID; use setChatToIndex to create or replace history",
            );
          return {
            ...chat,
            message: existingChat.message,
            btwSessions: Object.hasOwn(chat, "btwSessions")
              ? chat.btwSessions
              : existingChat.btwSessions,
            branchState: Object.hasOwn(chat, "branchState")
              ? chat.branchState
              : existingChat.branchState,
            messagesLoaded: existingChat.messagesLoaded,
            messagesFullyLoaded: existingChat.messagesFullyLoaded,
            messageOffset: existingChat.messageOffset,
            messageTotal: existingChat.messageTotal,
          };
        }),
      };
    }),
  };
}
