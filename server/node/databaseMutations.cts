"use strict";

const {
  describeSqlCommitChange,
  normalizeClientId,
} = require("./realtimeEvents.cjs");

function createDatabaseMutations({ getStorage, realtimeEventHub }) {
  const storage = () => getStorage();
  function emit(action, result, details, rawSourceClientId) {
    realtimeEventHub.broadcast("database-change", {
      ...(result?.revision == null ? {} : { revision: result.revision }),
      action,
      sourceClientId: normalizeClientId(rawSourceClientId),
      ...details,
    });
  }

  async function commit(payload, rawSourceClientId, options) {
    const result = await storage().sync(payload, options);
    emit(
      payload?.action || "sync",
      result,
      describeSqlCommitChange(payload),
      rawSourceClientId,
    );
    return result;
  }
  async function restoreBackup(payload, options, rawSourceClientId) {
    const result = await storage().sync(payload, options);
    emit("backup-restore", result, { replaceAll: true }, rawSourceClientId);
    return result;
  }

  async function togglePlugin(input, rawSourceClientId) {
    const result = await storage().sync({
      baseRevision: input.baseRevision,
      action: "plugin-toggle",
      root: {
        upserts: [{ key: "plugins", value: input.plugins }],
        deletes: [],
      },
    });
    emit(
      "plugin-toggle",
      result,
      {
        pluginName: input.pluginName,
        pluginEnabled: input.enabled,
      },
      rawSourceClientId,
    );
    return result;
  }
  async function createChatBranch(input, rawSourceClientId) {
    const result = await storage().createChatBranch(input);
    emit(
      "chat-branch-create",
      result,
      { chatIds: [input.chatId], charactersChanged: false },
      rawSourceClientId,
    );
    return result;
  }

  async function activateChatBranch(chatId, branchId, rawSourceClientId) {
    const result = await storage().activateChatBranch(chatId, branchId);
    emit(
      "chat-branch-activate",
      result,
      { chatIds: [chatId], charactersChanged: false },
      rawSourceClientId,
    );
    return result;
  }

  async function restoreRevision(revisionId, rawSourceClientId) {
    const result = await storage().restoreRevision(revisionId);
    emit("revision-restore", result, { replaceAll: true }, rawSourceClientId);
    return result;
  }
  async function updateSetting(key, value, rawSourceClientId) {
    const result = await storage().updateSetting(key, value);
    emit(
      "setting-update",
      result,
      { rootChanged: true, rootUpsertKeys: [key] },
      rawSourceClientId,
    );
    return result;
  }

  async function deleteSetting(key, rawSourceClientId) {
    const result = await storage().deleteSetting(key);
    emit(
      "setting-delete",
      result,
      { rootChanged: true, rootDeleteKeys: [key] },
      rawSourceClientId,
    );
    return result;
  }

  async function saveBotPreset(preset, position, rawSourceClientId) {
    const result = await storage().saveBotPreset(preset, position);
    emit("preset-save", result, { presetsChanged: true }, rawSourceClientId);
    return result;
  }

  async function saveModule(moduleData, rawSourceClientId) {
    const result = await storage().saveModule(moduleData);
    emit("module-save", result, { modulesChanged: true }, rawSourceClientId);
    return result;
  }
  async function deleteModule(moduleId, rawSourceClientId) {
    const result = await storage().deleteModule(moduleId);
    emit("module-delete", result, { modulesChanged: true }, rawSourceClientId);
    return result;
  }

  async function saveMessage(chatId, message, rawSourceClientId) {
    const result = await storage().saveMessage(chatId, message);
    emit(
      "message-save",
      result,
      { chatIds: [chatId], charactersChanged: false },
      rawSourceClientId,
    );
    return result;
  }

  async function deleteMessage(chatId, messageId, rawSourceClientId) {
    const result = await storage().deleteMessage(chatId, messageId);
    emit(
      "message-delete",
      result,
      { chatIds: [chatId], charactersChanged: false },
      rawSourceClientId,
    );
    return result;
  }

  return {
    activateChatBranch,
    commit,
    createChatBranch,
    deleteMessage,
    deleteModule,
    deleteSetting,
    restoreBackup,
    restoreRevision,
    saveBotPreset,
    saveMessage,
    saveModule,
    togglePlugin,
    updateSetting,
  };
}

module.exports = {
  createDatabaseMutations,
};
