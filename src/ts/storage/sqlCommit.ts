import type {
  Chat,
  Database,
  PortableDatabase,
  Message,
  character,
  groupChat,
  botPreset,
} from "./database.svelte";
import { v4 as uuidv4 } from "uuid";

export type {
  SqlSettingUpsert,
  SqlCharacterUpsert,
  SqlCharacterTouch,
  SqlChatUpsert,
  SqlMessageUpsert,
  SqlCommitResult,
} from "../../../packages/protocol/sqlCommit.cjs";
import type {
  SqlCommit as ProtocolSqlCommit,
  SqlPresetUpsert as ProtocolSqlPresetUpsert,
} from "../../../packages/protocol/sqlCommit.cjs";

export type SqlPresetUpsert = ProtocolSqlPresetUpsert<botPreset>;
export type SqlCommit = ProtocolSqlCommit<botPreset>;

export class SqlRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`SQL revision conflict: current revision is ${currentRevision}`);
    this.name = "SqlRevisionConflictError";
  }
}

export function createEmptySqlCommit(
  baseRevision: number,
  action?: string,
): SqlCommit {
  return {
    baseRevision,
    action,
    root: { upserts: [], deletes: [] },
    characters: [],
    characterTouches: [],
    chats: [],
    chatManifests: [],
    messages: [],
    messageManifests: [],
    messageDeletes: [],
  };
}

export function hasSqlCommitChanges(commit: SqlCommit): boolean {
  const hasPluginChanges = Boolean(
    commit.pluginStorage &&
    (commit.pluginStorage.upserts.length > 0 ||
      commit.pluginStorage.deletes.length > 0 ||
      commit.pluginStorage.clear),
  );
  return (
    commit.root.upserts.length > 0 ||
    commit.root.deletes.length > 0 ||
    hasPluginChanges ||
    Boolean(
      commit.presets &&
      (commit.presets.upserts.length > 0 ||
        commit.presets.deletes.length > 0 ||
        commit.presets.order !== undefined ||
        commit.presets.activeId !== undefined),
    ) ||
    commit.characters.length > 0 ||
    (commit.characterTouches !== undefined && commit.characterTouches.length > 0) ||
    commit.characterIds !== undefined ||
    commit.chats.length > 0 ||
    commit.chatManifests.length > 0 ||
    commit.messages.length > 0 ||
    commit.messageManifests.length > 0 ||
    (commit.messageDeletes !== undefined && commit.messageDeletes.length > 0)
  );
}

export function sqlCharacterData(value: character | groupChat): unknown {
  const {
    chats: _chats,
    chaId: _chaId,
    detailsLoaded: _detailsLoaded,
    ...data
  } = value;
  return data;
}

export function sqlChatData(value: Chat): unknown {
  const {
    message: _messages,
    id: _id,
    messagesLoaded: _messagesLoaded,
    messageOffset: _messageOffset,
    messageTotal: _messageTotal,
    messagesFullyLoaded: _messagesFullyLoaded,
    preventMessageCompaction: _preventMessageCompaction,
    detailsLoaded: _detailsLoaded,
    ...data
  } = value;
  return data;
}

export function sqlMessageData(value: Message): unknown {
  const { chatId: _messageId, ...data } = value;
  return data;
}

/** Used only by explicit database import/reset. Normal persistence must not call this. */
export function buildSqlReplaceCommit(
  database: Database,
  baseRevision: number,
): SqlCommit {
  const partialCharacter = (database.characters ?? []).find(
    (value) => value.detailsLoaded === false,
  );
  if (partialCharacter) {
    throw new Error(
      `Cannot replace SQL database from partially loaded character: ${partialCharacter.chaId || "unknown"}`,
    );
  }
  for (const currentCharacter of database.characters ?? []) {
    const partialChat = (currentCharacter.chats ?? []).find(
      (value) =>
        value.messagesLoaded === false || value.messagesFullyLoaded === false,
    );
    if (partialChat) {
      throw new Error(
        `Cannot replace SQL database from partially loaded chat: ${partialChat.id || "unknown"}`,
      );
    }
  }
  const commit = createEmptySqlCommit(baseRevision, "replace-all");
  commit.replaceAll = true;
  commit.characterIds = [];

  database.pluginCustomStorage ??= {};
  commit.pluginStorage = {
    upserts: Object.entries(database.pluginCustomStorage).map(
      ([key, value]) => ({ key, value }),
    ),
    deletes: [],
    clear: true,
  };
  const portableDatabase = database as Database & Partial<PortableDatabase>;
  const portablePresets = Array.isArray(portableDatabase.botPresets)
    ? portableDatabase.botPresets
    : [];
  // In the legacy database the root object is the live, editable view of the
  // active preset.  The matching botPresets entry is only synchronized at
  // explicit preset save/switch boundaries, so it can be stale during a SQL
  // migration.  Preserve the live module integration value instead of
  // allowing startup to replace it with an absent/old preset value.
  const activePresetIndex =
    portablePresets.length > 0
      ? Math.max(
          0,
          Math.min(
            Number(portableDatabase.botPresetsId) || 0,
            portablePresets.length - 1,
          ),
        )
      : -1;
  const presetIds = portablePresets.map(() => uuidv4());
  if (portablePresets.length > 0) {
    commit.presets = {
      upserts: portablePresets.map((data, position) => {
        const migratedData =
          position === activePresetIndex &&
          typeof database.moduleIntergration === "string"
            ? { ...data, moduleIntergration: database.moduleIntergration }
            : data;
        return {
          id: presetIds[position],
          position,
          data: migratedData,
        };
      }),
      deletes: [],
      order: presetIds,
      activeId: presetIds[activePresetIndex],
    };
  }
  for (const [key, value] of Object.entries(database)) {
    if (
      key !== "characters" &&
      value !== undefined &&
      typeof value !== "function" &&
      key !== "isSql" &&
      key !== "botPresets" &&
      key !== "botPresetsId"
    ) {
      commit.root.upserts.push({ key, value });
    }
  }
  for (
    let characterPosition = 0;
    characterPosition < (database.characters ?? []).length;
    characterPosition++
  ) {
    const currentCharacter = database.characters[characterPosition];
    currentCharacter.chaId ||= uuidv4();
    commit.characterIds.push(currentCharacter.chaId);
    commit.characters.push({
      id: currentCharacter.chaId,
      position: characterPosition,
      data: sqlCharacterData(currentCharacter),
    });
    const chats = currentCharacter.chats ?? [];
    for (const chat of chats) chat.id ||= uuidv4();
    commit.chatManifests.push({
      characterId: currentCharacter.chaId,
      ids: chats.map((chat) => chat.id!),
    });
    for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
      const chat = chats[chatPosition];
      commit.chats.push({
        id: chat.id!,
        characterId: currentCharacter.chaId,
        position: chatPosition,
        data: sqlChatData(chat),
      });
      const messages = chat.message ?? [];
      for (const message of messages) message.chatId ||= uuidv4();
      commit.messageManifests.push({
        chatId: chat.id!,
        ids: messages.map((message) => message.chatId!),
      });
      for (
        let messagePosition = 0;
        messagePosition < messages.length;
        messagePosition++
      ) {
        const message = messages[messagePosition];
        commit.messages.push({
          id: message.chatId!,
          chatId: chat.id!,
          position: messagePosition,
          data: sqlMessageData(message),
        });
      }
    }
  }
  return commit;
}
