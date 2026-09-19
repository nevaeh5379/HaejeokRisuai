import settings from "../../protocol/settings.json";
import {
  preparePortableDatabaseForBranchRestore,
  type PortableBranchGraph,
  type PortableBranchGraphMap,
} from "./portableBranches";

const LEGACY_PERSONA_MIRROR_KEYS = new Set<string>(
  settings.LEGACY_PERSONA_MIRROR_KEYS,
);

export type LegacyBackupSqlRecord =
  | { type: "meta"; formatVersion: 1; revision: number }
  | { type: "setting"; key: string; value: unknown }
  | { type: "plugin-storage"; key: string; value: unknown }
  | { type: "module"; position: number; id: string; data: unknown }
  | { type: "preset"; position: number; id: string; data: unknown }
  | { type: "character"; position: number; id: string; data: unknown }
  | {
      type: "chat";
      characterId: string;
      position: number;
      id: string;
      data: unknown;
    }
  | { type: "branch"; chatId: string; data: unknown }
  | { type: "active-branch"; chatId: string; branchId: string }
  | {
      type: "message";
      chatId: string;
      id: string;
      position: number;
      parentMessageId?: string;
      originBranchId: string;
      data: unknown;
    };

export interface LegacyBackupRecordOptions {
  sourceRevision?: number;
  idFactory?: () => string;
}

function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  throw new Error("Legacy backup record conversion requires an idFactory");
}

function characterData(character: Record<string, any>) {
  const {
    chats: _chats,
    chaId: _chaId,
    detailsLoaded: _detailsLoaded,
    ...data
  } = character;
  return data;
}

function chatData(chat: Record<string, any>) {
  const {
    message: _message,
    id: _id,
    messagesLoaded: _messagesLoaded,
    messagesFullyLoaded: _messagesFullyLoaded,
    detailsLoaded: _detailsLoaded,
    ...data
  } = chat;
  return data;
}

function messageData(message: Record<string, any>) {
  const { chatId: _id, ...data } = message;
  return data;
}

function uniqueMessageIds(
  messages: Array<Record<string, any>>,
  idFactory: () => string,
): string[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    let id =
      typeof message?.chatId === "string" && message.chatId.length > 0
        ? message.chatId
        : idFactory();
    while (seen.has(id)) id = idFactory();
    seen.add(id);
    message.chatId = id;
    return id;
  });
}

function sourceRoot(graph: PortableBranchGraph) {
  const ids = new Set(graph.branches.map((branch) => branch.id));
  return (
    graph.branches.find((branch) => branch.reason === "root") ??
    graph.branches.find(
      (branch) => !branch.parentBranchId || !ids.has(branch.parentBranchId),
    ) ??
    graph.branches[0]
  );
}

function* graphRecords(
  chatId: string,
  graph: PortableBranchGraph,
  idFactory: () => string,
): Generator<LegacyBackupSqlRecord> {
  const branches = Array.isArray(graph?.branches) ? graph.branches : [];
  const root = sourceRoot(graph);
  if (!root || branches.length === 0) return;

  for (const branch of branches) {
    yield {
      type: "branch",
      chatId,
      data: {
        ...branch,
        chatId,
      },
    };
  }

  const activeBranchId =
    graph.activeBranchId &&
    branches.some((branch) => branch.id === graph.activeBranchId)
      ? graph.activeBranchId
      : root.id;
  yield { type: "active-branch", chatId, branchId: activeBranchId };

  const links = new Map(
    (graph.links ?? []).map((link: any) => [link.messageId, link]),
  );
  const messages = Array.isArray(graph.messages)
    ? (graph.messages as Array<Record<string, any>>)
    : [];
  const messageIds = uniqueMessageIds(messages, idFactory);

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const id = messageIds[index];
    const link: any = links.get(id);
    const originBranchId =
      typeof link?.originBranchId === "string" &&
      branches.some((branch) => branch.id === link.originBranchId)
        ? link.originBranchId
        : root.id;
    const position =
      Number.isSafeInteger(link?.position) && Number(link.position) >= 0
        ? Number(link.position)
        : index;
    yield {
      type: "message",
      chatId,
      id,
      position,
      ...(typeof link?.parentMessageId === "string"
        ? { parentMessageId: link.parentMessageId }
        : {}),
      originBranchId,
      data: messageData(message),
    };
  }
}

function* linearChatRecords(
  chatId: string,
  messages: Array<Record<string, any>>,
  idFactory: () => string,
): Generator<LegacyBackupSqlRecord> {
  const ids = uniqueMessageIds(messages, idFactory);
  const rootId = "root";
  yield {
    type: "branch",
    chatId,
    data: {
      id: rootId,
      chatId,
      reason: "root",
      createdAt: 0,
      ...(ids.length > 0 ? { headMessageId: ids[ids.length - 1] } : {}),
    },
  };
  yield { type: "active-branch", chatId, branchId: rootId };

  for (let position = 0; position < messages.length; position++) {
    yield {
      type: "message",
      chatId,
      id: ids[position],
      position,
      ...(position > 0 ? { parentMessageId: ids[position - 1] } : {}),
      originBranchId: rootId,
      data: messageData(messages[position]),
    };
  }
}

export function* iterateLegacyBackupSqlRecords(
  source: Record<string, any>,
  options: LegacyBackupRecordOptions = {},
): Generator<LegacyBackupSqlRecord> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Legacy backup database must be an object");
  }

  const idFactory = options.idFactory ?? defaultIdFactory;
  const sourceRevision = Math.max(
    0,
    Number.isSafeInteger(options.sourceRevision)
      ? Number(options.sourceRevision)
      : 0,
  );

  const { database, branchGraphs } =
    preparePortableDatabaseForBranchRestore(source) as {
      database: Record<string, any>;
      branchGraphs: PortableBranchGraphMap;
    };

  const presets = Array.isArray(database.botPresets)
    ? database.botPresets
    : [];
  const presetIds = presets.map(() => idFactory());
  const activePresetIndex =
    presets.length > 0
      ? Math.max(
          0,
          Math.min(
            Number(database.botPresetsId) || 0,
            presets.length - 1,
          ),
        )
      : -1;

  yield { type: "meta", formatVersion: 1, revision: sourceRevision };

  const excludedSettings = new Set([
    "characters",
    "modules",
    "botPresets",
    "botPresetsId",
    "pluginCustomStorage",
    "isSql",
  ]);
  for (const [key, value] of Object.entries(database)) {
    if (
      excludedSettings.has(key) ||
      LEGACY_PERSONA_MIRROR_KEYS.has(key) ||
      value === undefined ||
      typeof value === "function"
    ) {
      continue;
    }
    if (key === "activeBotPresetId" && presets.length > 0) continue;
    yield { type: "setting", key, value };
  }
  if (presets.length > 0) {
    yield {
      type: "setting",
      key: "activeBotPresetId",
      value: presetIds[activePresetIndex],
    };
  }

  const pluginStorage =
    database.pluginCustomStorage &&
    typeof database.pluginCustomStorage === "object" &&
    !Array.isArray(database.pluginCustomStorage)
      ? database.pluginCustomStorage
      : {};
  for (const [key, value] of Object.entries(pluginStorage)) {
    yield { type: "plugin-storage", key, value };
  }

  const modules = Array.isArray(database.modules) ? database.modules : [];
  for (let position = 0; position < modules.length; position++) {
    const module = modules[position];
    const id =
      typeof module?.id === "string" && module.id.length > 0
        ? module.id
        : idFactory();
    module.id = id;
    yield { type: "module", position, id, data: module };
  }

  for (let position = 0; position < presets.length; position++) {
    const data =
      position === activePresetIndex &&
      typeof database.moduleIntergration === "string"
        ? {
            ...presets[position],
            moduleIntergration: database.moduleIntergration,
          }
        : presets[position];
    yield {
      type: "preset",
      position,
      id: presetIds[position],
      data,
    };
  }

  const characters = Array.isArray(database.characters)
    ? database.characters
    : [];
  for (
    let characterPosition = 0;
    characterPosition < characters.length;
    characterPosition++
  ) {
    const character = characters[characterPosition];
    const characterId =
      typeof character?.chaId === "string" && character.chaId.length > 0
        ? character.chaId
        : idFactory();
    character.chaId = characterId;

    yield {
      type: "character",
      position: characterPosition,
      id: characterId,
      data: characterData(character),
    };

    const chats = Array.isArray(character.chats) ? character.chats : [];
    for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
      const chat = chats[chatPosition];
      const chatId =
        typeof chat?.id === "string" && chat.id.length > 0
          ? chat.id
          : idFactory();
      chat.id = chatId;

      yield {
        type: "chat",
        characterId,
        position: chatPosition,
        id: chatId,
        data: chatData(chat),
      };

      const graph = branchGraphs[chatId];
      if (
        graph &&
        Array.isArray(graph.branches) &&
        graph.branches.length > 0
      ) {
        yield* graphRecords(chatId, graph, idFactory);
      } else {
        const messages = Array.isArray(chat.message)
          ? chat.message
          : [];
        yield* linearChatRecords(chatId, messages, idFactory);
      }
    }
  }
}
