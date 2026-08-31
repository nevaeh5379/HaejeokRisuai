import type { Chat, Database, PortableDatabase, Message, character, groupChat, botPreset } from "../database/schema";
import { v4 as uuidv4 } from "uuid";
import { isLegacyPersonaMirrorKey } from "./sqlDeferredSettings";

export type {
  SqlSettingUpsert,
  SqlCharacterUpsert,
  SqlCharacterTouch,
  SqlChatUpsert,
  SqlMessageUpsert,
  SqlModuleUpsert,
  SqlCommitResult,
} from "../../../../packages/protocol/sqlCommit.cjs";
import type {
  SqlCommit as ProtocolSqlCommit,
  SqlPresetUpsert as ProtocolSqlPresetUpsert,
} from "../../../../packages/protocol/sqlCommit.cjs";

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
    characterDeletes: [],
    chats: [],
    chatManifests: [],
    chatDeletes: [],
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
    Boolean(
      commit.modules &&
      (commit.modules.upserts.length > 0 ||
        commit.modules.deletes.length > 0 ||
        commit.modules.order !== undefined),
    ) ||
    commit.characters.length > 0 ||
    (commit.characterTouches !== undefined && commit.characterTouches.length > 0) ||
    commit.characterIds !== undefined ||
    (commit.characterDeletes !== undefined && commit.characterDeletes.length > 0) ||
    commit.chats.length > 0 ||
    commit.chatManifests.length > 0 ||
    (commit.chatDeletes !== undefined && commit.chatDeletes.length > 0) ||
    commit.messages.length > 0 ||
    commit.messageManifests.length > 0 ||
    (commit.messageDeletes !== undefined && commit.messageDeletes.length > 0)
  );
}

export function mergeLegacyModulesIntoCommit(
  commit: SqlCommit,
  legacyModules: unknown,
): void {
  if (!commit.modules || !Array.isArray(legacyModules)) return;

  const deleted = new Set(commit.modules.deletes);
  const changed = new Set(commit.modules.upserts.map((entry) => entry.id));
  const inferredOrder = [
    ...legacyModules
      .filter(
        (module): module is { id: string } & Record<string, unknown> =>
          Boolean(
            module &&
              typeof module === "object" &&
              typeof (module as { id?: unknown }).id === "string",
          ),
      )
      .map((module) => module.id)
      .filter((id) => !deleted.has(id)),
    ...commit.modules.upserts
      .map((entry) => entry.id)
      .filter((id) => !deleted.has(id)),
  ];
  const order =
    commit.modules.order ?? [...new Set(inferredOrder)];
  const positions = new Map(order.map((id, position) => [id, position]));
  const migrated = legacyModules.flatMap((module) => {
    if (
      !module ||
      typeof module !== "object" ||
      typeof (module as { id?: unknown }).id !== "string"
    ) return [];
    const data = module as { id: string } & Record<string, unknown>;
    if (deleted.has(data.id) || changed.has(data.id)) return [];
    return [{ id: data.id, position: positions.get(data.id) ?? 0, data }];
  });
  commit.modules.upserts = [...migrated, ...commit.modules.upserts];
  commit.modules.order = order;
  if (!commit.root.deletes.includes("modules")) {
    commit.root.deletes.push("modules");
  }
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

/**
 * Legacy saves can contain repeated message IDs within one chat. Relational
 * storage uses (chat_id, id) as the message primary key, so leaving those IDs
 * unchanged either drops a message or makes PostgreSQL reject the whole
 * restore. Keep the first occurrence stable and assign fresh IDs only to
 * missing or later conflicting messages.
 */
function ensureUniqueMessageIds(messages: Message[]): string[] {
  const usedIds = new Set<string>();
  const messageIds: string[] = [];

  for (const message of messages) {
    let messageId = message.chatId;
    if (!messageId || usedIds.has(messageId)) {
      do {
        messageId = uuidv4();
      } while (usedIds.has(messageId));
      message.chatId = messageId;
    }
    usedIds.add(messageId);
    messageIds.push(messageId);
  }

  return messageIds;
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
  const modules = Array.isArray(database.modules) ? database.modules : [];
  commit.modules = {
    upserts: modules.map((data, position) => ({
      id: data.id,
      position,
      data,
    })),
    deletes: [],
    order: modules.map((module) => module.id),
  };
  for (const [key, value] of Object.entries(database)) {
    if (
      key !== "characters" &&
      value !== undefined &&
      typeof value !== "function" &&
      key !== "isSql" &&
      key !== "botPresets" &&
      key !== "botPresetsId" &&
      key !== "modules" &&
      // Preset activation is owned by the presets section: the server derives
      // `activeBotPresetId` from presets.activeId and pushes it into the root
      // upserts itself. Emitting it here as well would duplicate the key in a
      // single bulk upsert, which PostgreSQL rejects with "ON CONFLICT DO
      // UPDATE command cannot affect row a second time" during restores.
      key !== "activeBotPresetId" &&
      !isLegacyPersonaMirrorKey(key)
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
      const messageIds = ensureUniqueMessageIds(messages);
      commit.messageManifests.push({
        chatId: chat.id!,
        ids: messageIds,
      });
      for (
        let messagePosition = 0;
        messagePosition < messages.length;
        messagePosition++
      ) {
        const message = messages[messagePosition];
        commit.messages.push({
          id: messageIds[messagePosition],
          chatId: chat.id!,
          position: messagePosition,
          data: sqlMessageData(message),
        });
      }
    }
  }
  return commit;
}

/**
 * Build only the root/settings portion of a replace-all commit. Capacitor uses
 * this together with entity batches so a large legacy database is never
 * duplicated into one giant SqlCommit object before native streaming starts.
 */
export function buildSqlReplaceRootCommit(
  database: Database,
  baseRevision: number,
): SqlCommit {
  return buildSqlReplaceCommit(
    { ...database, characters: [] } as Database,
    baseRevision,
  );
}

export function* iterateSqlReplaceEntityCommits(
  database: Database,
  baseRevision: number,
  messageBatchSize = 128,
): Generator<SqlCommit> {
  if (!Number.isSafeInteger(messageBatchSize) || messageBatchSize < 1) {
    throw new Error("SQL restore message batch size must be a positive integer");
  }
  const characterIds: string[] = [];
  for (let characterPosition = 0; characterPosition < (database.characters ?? []).length; characterPosition++) {
    const currentCharacter = database.characters[characterPosition];
    if (currentCharacter.detailsLoaded === false) {
      throw new Error(
        `Cannot replace SQL database from partially loaded character: ${currentCharacter.chaId || "unknown"}`,
      );
    }
    currentCharacter.chaId ||= uuidv4();
    characterIds.push(currentCharacter.chaId);

    const chats = currentCharacter.chats ?? [];
    for (const chat of chats) {
      if (chat.messagesLoaded === false || chat.messagesFullyLoaded === false) {
        throw new Error(
          `Cannot replace SQL database from partially loaded chat: ${chat.id || "unknown"}`,
        );
      }
      chat.id ||= uuidv4();
    }

    const characterCommit = createEmptySqlCommit(baseRevision, "replace-entities");
    characterCommit.characters.push({
      id: currentCharacter.chaId,
      position: characterPosition,
      data: sqlCharacterData(currentCharacter),
    });
    characterCommit.chatManifests.push({
      characterId: currentCharacter.chaId,
      ids: chats.map((chat) => chat.id!),
    });
    yield characterCommit;

    for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
      const chat = chats[chatPosition];
      const messages = chat.message ?? [];
      const messageIds = ensureUniqueMessageIds(messages);

      const chatCommit = createEmptySqlCommit(baseRevision, "replace-entities");
      chatCommit.chats.push({
        id: chat.id!,
        characterId: currentCharacter.chaId,
        position: chatPosition,
        data: sqlChatData(chat),
      });
      chatCommit.messageManifests.push({
        chatId: chat.id!,
        ids: messageIds,
      });
      yield chatCommit;

      for (let offset = 0; offset < messages.length; offset += messageBatchSize) {
        const messageCommit = createEmptySqlCommit(baseRevision, "replace-entities");
        const end = Math.min(messages.length, offset + messageBatchSize);
        for (let messagePosition = offset; messagePosition < end; messagePosition++) {
          const message = messages[messagePosition];
          messageCommit.messages.push({
            id: messageIds[messagePosition],
            chatId: chat.id!,
            position: messagePosition,
            data: sqlMessageData(message),
          });
        }
        yield messageCommit;
      }
    }
  }

  const orderCommit = createEmptySqlCommit(baseRevision, "replace-entities");
  orderCommit.characterIds = characterIds;
  yield orderCommit;
}
