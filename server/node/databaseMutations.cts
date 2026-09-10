"use strict";

const {
  describeSqlCommitChange,
  normalizeClientId,
} = require("./realtimeEvents.cjs");

type ServerMutationStorage = {
  sync: (payload: any, options?: any) => Promise<any>;
  createChatBranch: (input: any) => Promise<any>;
  activateChatBranch: (chatId: string, branchId: string) => Promise<void>;
  restoreRevision: (revisionId: any) => Promise<any>;
  updateSetting: (key: string, value: any) => Promise<any>;
  deleteSetting: (key: string) => Promise<any>;
  saveBotPreset: (preset: any, position: any) => Promise<any>;
  saveModule: (moduleData: any) => Promise<any>;
  deleteModule: (moduleId: string) => Promise<any>;
  saveMessage: (chatId: string, message: any) => Promise<any>;
  deleteMessage: (chatId: string, messageId: string) => Promise<any>;
};

type MutationArgs = {
  commit: [payload: any, rawSourceClientId: unknown, options?: any];
  restoreBackup: [payload: any, options: any, rawSourceClientId: unknown];
  togglePlugin: [input: any, rawSourceClientId: unknown];
  createChatBranch: [input: any, rawSourceClientId: unknown];
  activateChatBranch: [
    chatId: string,
    branchId: string,
    rawSourceClientId: unknown,
  ];
  restoreRevision: [revisionId: any, rawSourceClientId: unknown];
  updateSetting: [key: string, value: any, rawSourceClientId: unknown];
  deleteSetting: [key: string, rawSourceClientId: unknown];
  saveBotPreset: [preset: any, position: any, rawSourceClientId: unknown];
  saveModule: [moduleData: any, rawSourceClientId: unknown];
  deleteModule: [moduleId: string, rawSourceClientId: unknown];
  saveMessage: [chatId: string, message: any, rawSourceClientId: unknown];
  deleteMessage: [
    chatId: string,
    messageId: string,
    rawSourceClientId: unknown,
  ];
};
type MutationName = keyof MutationArgs;

type DatabaseChangeDescriptor = {
  action: string;
  details?: Record<string, unknown>;
  rawSourceClientId: unknown;
};

type MutationDefinition<K extends MutationName> = {
  mutate: (...args: MutationArgs[K]) => Promise<any>;
  describe: (result: any, ...args: MutationArgs[K]) => DatabaseChangeDescriptor;
};

type MutationDefinitionRegistry = {
  [K in MutationName]: MutationDefinition<K>;
};

type DatabaseMutationApi = {
  [K in MutationName]: (...args: MutationArgs[K]) => Promise<any>;
};

type DatabaseMutationDependencies = {
  getStorage: () => ServerMutationStorage;
  realtimeEventHub: {
    broadcast: (event: string, data: Record<string, unknown>) => void;
  };
};

function createDatabaseMutations({
  getStorage,
  realtimeEventHub,
}: DatabaseMutationDependencies): DatabaseMutationApi {
  const storage = () => getStorage();
  function emit(result: any, descriptor: DatabaseChangeDescriptor) {
    realtimeEventHub.broadcast("database-change", {
      ...(result?.revision == null ? {} : { revision: result.revision }),
      action: descriptor.action,
      sourceClientId: normalizeClientId(descriptor.rawSourceClientId),
      ...(descriptor.details ?? {}),
    });
  }

  const definitions = {
    commit: {
      mutate: async (payload, _source, options) =>
        await storage().sync(payload, options),
      describe: (_result, payload, rawSourceClientId) => ({
        action: payload?.action || "sync",
        details: describeSqlCommitChange(payload),
        rawSourceClientId,
      }),
    },
    restoreBackup: {
      mutate: async (payload, options) =>
        await storage().sync(payload, options),
      describe: (_result, _payload, _options, rawSourceClientId) => ({
        action: "backup-restore",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    togglePlugin: {
      mutate: async (input) =>
        await storage().sync({
          baseRevision: input.baseRevision,
          action: "plugin-toggle",
          root: {
            upserts: [{ key: "plugins", value: input.plugins }],
            deletes: [],
          },
        }),
      describe: (_result, input, rawSourceClientId) => ({
        action: "plugin-toggle",
        details: {
          pluginName: input.pluginName,
          pluginEnabled: input.enabled,
        },
        rawSourceClientId,
      }),
    },
    createChatBranch: {
      mutate: async (input) => await storage().createChatBranch(input),
      describe: (_result, input, rawSourceClientId) => ({
        action: "chat-branch-create",
        details: { chatIds: [input.chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    activateChatBranch: {
      mutate: async (chatId, branchId) =>
        await storage().activateChatBranch(chatId, branchId),
      describe: (_result, chatId, _branchId, rawSourceClientId) => ({
        action: "chat-branch-activate",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    restoreRevision: {
      mutate: async (revisionId) => await storage().restoreRevision(revisionId),
      describe: (_result, _revisionId, rawSourceClientId) => ({
        action: "revision-restore",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    updateSetting: {
      mutate: async (key, value) => await storage().updateSetting(key, value),
      describe: (_result, key, _value, rawSourceClientId) => ({
        action: "setting-update",
        details: { rootChanged: true, rootUpsertKeys: [key] },
        rawSourceClientId,
      }),
    },
    deleteSetting: {
      mutate: async (key) => await storage().deleteSetting(key),
      describe: (_result, key, rawSourceClientId) => ({
        action: "setting-delete",
        details: { rootChanged: true, rootDeleteKeys: [key] },
        rawSourceClientId,
      }),
    },
    saveBotPreset: {
      mutate: async (preset, position) =>
        await storage().saveBotPreset(preset, position),
      describe: (_result, _preset, _position, rawSourceClientId) => ({
        action: "preset-save",
        details: { presetsChanged: true },
        rawSourceClientId,
      }),
    },
    saveModule: {
      mutate: async (moduleData) => await storage().saveModule(moduleData),
      describe: (_result, _moduleData, rawSourceClientId) => ({
        action: "module-save",
        details: { modulesChanged: true },
        rawSourceClientId,
      }),
    },
    deleteModule: {
      mutate: async (moduleId) => await storage().deleteModule(moduleId),
      describe: (_result, _moduleId, rawSourceClientId) => ({
        action: "module-delete",
        details: { modulesChanged: true },
        rawSourceClientId,
      }),
    },
    saveMessage: {
      mutate: async (chatId, message) =>
        await storage().saveMessage(chatId, message),
      describe: (_result, chatId, _message, rawSourceClientId) => ({
        action: "message-save",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    deleteMessage: {
      mutate: async (chatId, messageId) =>
        await storage().deleteMessage(chatId, messageId),
      describe: (_result, chatId, _messageId, rawSourceClientId) => ({
        action: "message-delete",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
  } satisfies MutationDefinitionRegistry;
  async function execute<K extends MutationName>(
    name: K,
    ...args: MutationArgs[K]
  ): Promise<any> {
    const definition = definitions[name] as MutationDefinition<K>;
    const result = await definition.mutate(...args);
    emit(result, definition.describe(result, ...args));
    return result;
  }

  return {
    commit: (...args) => execute("commit", ...args),
    restoreBackup: (...args) => execute("restoreBackup", ...args),
    togglePlugin: (...args) => execute("togglePlugin", ...args),
    createChatBranch: (...args) => execute("createChatBranch", ...args),
    activateChatBranch: (...args) => execute("activateChatBranch", ...args),
    restoreRevision: (...args) => execute("restoreRevision", ...args),
    updateSetting: (...args) => execute("updateSetting", ...args),
    deleteSetting: (...args) => execute("deleteSetting", ...args),
    saveBotPreset: (...args) => execute("saveBotPreset", ...args),
    saveModule: (...args) => execute("saveModule", ...args),
    deleteModule: (...args) => execute("deleteModule", ...args),
    saveMessage: (...args) => execute("saveMessage", ...args),
    deleteMessage: (...args) => execute("deleteMessage", ...args),
  } satisfies DatabaseMutationApi;
}

module.exports = { createDatabaseMutations };
