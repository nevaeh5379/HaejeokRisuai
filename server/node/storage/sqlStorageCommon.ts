"use strict";

import * as fs from "fs/promises";
import {
  createSqlCommitValidator,
  deriveSqlCommitImpact,
  readSqlCommitImpactSink,
} from "../../../packages/protocol/src/sqlCommit.ts";

const DEFAULT_MAX_COLD_STORAGE_KEYS: any = 250000;
const MAX_COLD_STORAGE_CHATS_PER_CHARACTER: any = 100000;
const MAX_COLD_STORAGE_MESSAGES_PER_CHAT: any = 1000000;
const UUID_PATTERN: any =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPAT_UUID_PATTERN: any =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12}$/i;

import jsonSettings from "../../../packages/protocol/settings.json" with { type: "json" };
const {
  DEFERRED_SETTING_KEYS,
  DEFERRED_STARTUP_SETTING_KEYS,
  PROMPT_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  DOMAIN_STORE_SETTING_KEYS,
  NON_SETTINGS_ROOT_KEYS,
  BOOTSTRAP_SETTING_KEYS,
} = jsonSettings;
const LEGACY_PERSONA_MIRROR_KEY_SET: any = new Set(LEGACY_PERSONA_MIRROR_KEYS);
const SETTINGS_STORE_EXCLUDED_KEYS: any = [
  ...new Set([...NON_SETTINGS_ROOT_KEYS, ...DOMAIN_STORE_SETTING_KEYS]),
];

function mergeLegacyModulesIntoPayload(
  payload?: any,
  legacyModules?: any,
): any {
  if (!payload.modules || !Array.isArray(legacyModules)) return;
  const deleted: any = new Set(payload.modules.deletes);
  const changed: any = new Set(
    payload.modules.upserts.map((entry?: any) => entry.id),
  );
  const inferredOrder: any = [
    ...legacyModules
      .filter(
        (module?: any) =>
          module && typeof module === "object" && typeof module.id === "string",
      )
      .map((module?: any) => module.id)
      .filter((id?: any) => !deleted.has(id)),
    ...payload.modules.upserts
      .map((entry?: any) => entry.id)
      .filter((id?: any) => !deleted.has(id)),
  ];
  const order: any = payload.modules.order || [...new Set(inferredOrder)];
  const positions: any = new Map(
    order.map((id?: any, position?: any) => [id, position]),
  );
  const migrated: any = legacyModules.flatMap((module?: any) => {
    if (
      !module ||
      typeof module !== "object" ||
      typeof module.id !== "string" ||
      deleted.has(module.id) ||
      changed.has(module.id)
    )
      return [];
    return [
      { id: module.id, position: positions.get(module.id) || 0, data: module },
    ];
  });
  payload.modules.upserts = [...migrated, ...payload.modules.upserts];
  payload.modules.order = order;
  if (!payload.rootDeletes.includes("modules"))
    payload.rootDeletes.push("modules");
}

class SqlStorageBase {
  [key: string]: any;

  constructor() {
    this.objectCacheEnabled = process.env.RISUAI_SQL_OBJECT_CACHE === "1";
    this.pluginsCache = null;
    this.pluginCustomStorageCache = null;
    // Bootstrap is on every application's critical path, so keep this
    // compact settings snapshot regardless of the optional general object
    // cache. It is invalidated only by writes to bootstrap setting keys.
    this.bootstrapCache = null;
    this.bootstrapCachePromise = null;
    this.bootstrapCacheGeneration = 0;
  }

  invalidatePluginsCache(): any {
    this.pluginsCache = null;
  }

  invalidatePluginCustomStorageCache(): any {
    this.pluginCustomStorageCache = null;
  }

  invalidateBootstrapCache(changedKeys?: any): any {
    if (
      Array.isArray(changedKeys) &&
      !changedKeys.some((key?: any) => BOOTSTRAP_SETTING_KEYS.includes(key))
    )
      return;
    this.bootstrapCacheGeneration += 1;
    this.bootstrapCache = null;
    this.bootstrapCachePromise = null;
  }

  async loadChatMessages(chatId?: any): Promise<any> {
    const chat: any = await this.loadChat(chatId);
    return chat ? chat.message : [];
  }

  async loadPluginsData(): Promise<any> {
    const [pluginsResult, storageResult] = await Promise.all([
      this.loadPlugins(),
      this.loadPluginCustomStorage(),
    ]);
    return {
      plugins: pluginsResult.plugins,
      pluginCustomStorage: storageResult.pluginCustomStorage,
      hash: `${pluginsResult.hash}:${storageResult.hash}`,
    };
  }

  async loadBootstrapData(): Promise<any> {
    if (this.bootstrapCache) return this.bootstrapCache;
    if (this.bootstrapCachePromise) return this.bootstrapCachePromise;

    const generation: any = this.bootstrapCacheGeneration;
    const pending: any = this.loadSettingKeys(BOOTSTRAP_SETTING_KEYS)
      .then(({ settings, hash }: any) => {
        const result: any = { database: settings, hash };
        if (generation === this.bootstrapCacheGeneration)
          this.bootstrapCache = result;
        return result;
      })
      .finally(() => {
        if (this.bootstrapCachePromise === pending)
          this.bootstrapCachePromise = null;
      });
    this.bootstrapCachePromise = pending;
    return pending;
  }

  async warmBootstrapCache(): Promise<any> {
    if (!this.enabled) return;
    await this.loadBootstrapData();
  }

  async loadPersonas(): Promise<any> {
    return this.loadSettingCollection("personas", "personas");
  }

  async loadLorebooks(): Promise<any> {
    return this.loadSettingCollection("loreBook", "loreBook");
  }

  async loadModules(): Promise<any> {
    if (typeof this.loadModuleRecords === "function") {
      const records: any = await this.loadModuleRecords();
      if (records) return records;
    }
    return this.loadSettingCollection("modules", "modules");
  }

  async loadSettingCollection(settingKey?: any, resultKey?: any): Promise<any> {
    const { settings, hash } = await this.loadSettingKeys([settingKey]);
    return { [resultKey]: settings[settingKey] || [], hash };
  }

  async loadPrompts(): Promise<any> {
    const { settings, hash } = await this.loadSettingKeys(PROMPT_SETTING_KEYS);
    return { prompts: settings, hash };
  }

  async loadScripts(): Promise<any> {
    const { settings, hash } = await this.loadSettingKeys(["globalscript"]);
    return { globalscript: settings.globalscript || [], hash };
  }

  async loadSettingKey(key?: any): Promise<any> {
    const { settings, hash } = await this.loadSettingKeys([key]);
    return {
      key,
      value: settings[key] !== undefined ? settings[key] : null,
      exists: settings[key] !== undefined,
      hash,
    };
  }
}

/**
 * SQL-dialect-independent validation and normalization shared by every
 * relational storage driver. Database-specific queries stay in each driver.
 */
function createSqlStorageHelpers({
  PayloadError,
  maxIdLength = 4000,
  maxColdStorageKeys = DEFAULT_MAX_COLD_STORAGE_KEYS,
  allowShortColdStorageKeys = false,
  suppressLegacyReadErrors = false,
}: any = {}): any {
  if (typeof PayloadError !== "function") {
    throw new TypeError("PayloadError must be an error constructor");
  }

  const coldStorageKeyPattern: any = allowShortColdStorageKeys
    ? COMPAT_UUID_PATTERN
    : UUID_PATTERN;
  const coldStoragePathPattern: any = new RegExp(
    `^coldstorage/(${coldStorageKeyPattern.source.slice(1, -1)})$`,
    "i",
  );

  function asArray(value?: any, field?: any): any {
    if (value === undefined) return [];
    if (!Array.isArray(value))
      throw new PayloadError(`${field} must be an array`);
    return value;
  }

  function assertId(value?: any, field?: any): any {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maxIdLength
    ) {
      throw new PayloadError(
        `${field} must be a non-empty string of at most ${maxIdLength} characters`,
      );
    }
  }

  function assertPosition(value?: any, field?: any): any {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PayloadError(`${field} must be a non-negative integer`);
    }
  }

  function assertData(row?: any, field?: any): any {
    if (
      !row ||
      !Object.prototype.hasOwnProperty.call(row, "data") ||
      row.data === null ||
      typeof row.data !== "object" ||
      Array.isArray(row.data)
    ) {
      throw new PayloadError(`${field} must be a JSON object`);
    }
  }

  function normalizeColdStorageKey(
    value?: any,
    field: any = "coldStorageKey",
  ): any {
    if (typeof value !== "string" || !coldStorageKeyPattern.test(value)) {
      throw new PayloadError(`${field} must be a UUID`);
    }
    return value.toLowerCase();
  }

  function validateColdStorageValue(value?: any): any {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") {
      throw new PayloadError(
        "Cold storage data must be an array or an object containing character or message data",
      );
    }
    if ("character" in value) {
      const character: any = value.character;
      if (
        !character ||
        typeof character !== "object" ||
        Array.isArray(character) ||
        (character.chats !== undefined && !Array.isArray(character.chats))
      ) {
        throw new PayloadError("Cold storage character data is invalid");
      }
      const chats: any = character.chats || [];
      if (chats.length > MAX_COLD_STORAGE_CHATS_PER_CHARACTER) {
        throw new PayloadError("Cold storage character has too many chats");
      }
      for (const chat of chats) {
        if (
          !chat ||
          typeof chat !== "object" ||
          Array.isArray(chat) ||
          (chat.message !== undefined && !Array.isArray(chat.message))
        ) {
          throw new PayloadError("Cold storage character chat data is invalid");
        }
        validateMessages(chat.message || []);
      }
      return value;
    }
    if (!("message" in value) || !Array.isArray(value.message)) {
      throw new PayloadError(
        "Cold storage data must be an array or an object containing character or message data",
      );
    }
    validateMessages(value.message);
    return value;
  }

  function validateMessages(messages?: any): any {
    if (messages.length > MAX_COLD_STORAGE_MESSAGES_PER_CHAT) {
      throw new PayloadError("Cold storage chat has too many messages");
    }
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new PayloadError("Cold storage message data is invalid");
      }
    }
  }

  function splitColdStorageValue(rawValue?: any): any {
    const value: any = validateColdStorageValue(rawValue);
    if (Array.isArray(value)) {
      return {
        kind: "legacy",
        data: value,
        chats: [],
        messages: [],
        characterFields: [],
      };
    }
    if ("character" in value) {
      const { chats = [], ...characterData } = value.character;
      const normalizedChats: any = [];
      const normalizedMessages: any = [];
      const chatCount: any = Math.min(
        chats.length,
        MAX_COLD_STORAGE_CHATS_PER_CHARACTER,
      );
      for (
        let chatPosition: any = 0;
        chatPosition < chatCount;
        chatPosition++
      ) {
        const { message = [], ...chatData } = chats[chatPosition];
        normalizedChats.push({
          position: chatPosition,
          data: chatData,
          fields: Object.keys(chats[chatPosition]),
        });
        const messageCount: any = Math.min(
          message.length,
          MAX_COLD_STORAGE_MESSAGES_PER_CHAT,
        );
        for (
          let messagePosition: any = 0;
          messagePosition < messageCount;
          messagePosition++
        ) {
          normalizedMessages.push({
            chatPosition,
            position: messagePosition,
            data: message[messagePosition],
            fields: Object.keys(message[messagePosition]),
          });
        }
      }
      return {
        kind: "character",
        data: { ...value, character: characterData },
        chats: normalizedChats,
        messages: normalizedMessages,
        characterFields: Object.keys(value.character),
      };
    }
    const { message, ...chatData } = value;
    return {
      kind: "chat",
      data: chatData,
      chats: [{ position: 0, data: {}, fields: Object.keys(value) }],
      messages: message.map((item?: any, position?: any) => ({
        chatPosition: 0,
        position,
        data: item,
        fields: Object.keys(item),
      })),
      characterFields: [],
    };
  }

  function validateColdStorageKeys(value?: any, field: any = "keys"): any {
    const keys: any = asArray(value, field);
    if (keys.length > maxColdStorageKeys) {
      throw new PayloadError(
        `${field} exceeds the ${maxColdStorageKeys} key limit`,
      );
    }
    return Array.from(
      new Set(
        keys.map((key?: any) => normalizeColdStorageKey(key, `${field}[]`)),
      ),
    );
  }

  async function findLegacyColdStorageFiles(savePath?: any): Promise<any> {
    try {
      const entries: any = await fs.readdir(savePath, { withFileTypes: true });
      const candidates: any = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^(?:[0-9a-f]{2})+$/i.test(entry.name))
          continue;
        const logicalPath: any = Buffer.from(entry.name, "hex").toString(
          "utf8",
        );
        if (
          Buffer.from(logicalPath, "utf8").toString("hex") !==
          entry.name.toLowerCase()
        )
          continue;
        const match: any = logicalPath.match(coldStoragePathPattern);
        if (match)
          candidates.push({
            filename: entry.name,
            key: match[1].toLowerCase(),
          });
      }
      return candidates;
    } catch (error: any) {
      if (suppressLegacyReadErrors) return [];
      throw error;
    }
  }

  const validateProtocolSyncPayload: any = createSqlCommitValidator({
    PayloadError,
    maxIdLength,
  });
  const validateSyncPayload: any = (rawPayload?: any) => {
    const payload: any = validateProtocolSyncPayload(rawPayload);
    const legacyUpsert: any = payload.rootUpserts.find((upsert?: any) =>
      LEGACY_PERSONA_MIRROR_KEY_SET.has(upsert.key),
    );
    if (legacyUpsert) {
      throw new PayloadError(
        `${legacyUpsert.key} is a legacy persona mirror and cannot be persisted`,
      );
    }
    return payload;
  };

  // Derives the compact realtime impact of a validated commit exactly once
  // and reports it through the internal channel installed by
  // databaseMutations. The impact stays in memory and never reaches HTTP
  // responses; it only feeds the realtime broadcast after the write succeeds.
  // 검증된 커밋의 압축 실시간 영향을 정확히 한 번 도출하여, databaseMutations가
  // 설치한 내부 채널로 보고합니다. 영향은 HTTP 응답으로 새어 나가지 않고,
  // 쓰기가 성공한 뒤의 실시간 전파에만 쓰입니다.
  const captureSyncCommitImpact: any = (options?: any, payload?: any) => {
    const sink: any = readSqlCommitImpactSink(options);
    if (!sink) return;
    sink(deriveSqlCommitImpact(payload));
  };

  // Preset handling pushes `activeBotPresetId` into rootUpserts after
  // validation. Restores built from portable databases can already contain
  // that key, and a duplicated key makes the single-statement bulk upsert
  // fail with "ON CONFLICT DO UPDATE command cannot affect row a second
  // time" on PostgreSQL. Keep the last occurrence, matching ordinary
  // last-write-wins upsert semantics.
  const dedupeRootUpserts: any = (payload?: any) => {
    const seen: any = new Set();
    for (let index: any = payload.rootUpserts.length - 1; index >= 0; index--) {
      const key: any = payload.rootUpserts[index].key;
      if (seen.has(key)) {
        payload.rootUpserts.splice(index, 1);
      } else {
        seen.add(key);
      }
    }
    return payload;
  };

  return {
    asArray,
    assertId,
    assertPosition,
    assertData,
    normalizeColdStorageKey,
    validateColdStorageValue,
    splitColdStorageValue,
    validateColdStorageKeys,
    findLegacyColdStorageFiles,
    validateSyncPayload,
    captureSyncCommitImpact,
    dedupeRootUpserts,
  };
}

function groupRows(rows?: any, key?: any): any {
  const grouped: any = new Map();
  for (const row of rows) {
    const id: any = row[key];
    const items: any = grouped.get(id) || [];
    items.push(row);
    grouped.set(id, items);
  }
  return grouped;
}

function groupMessageRows(rows?: any): any {
  const grouped: any = new Map();
  for (const row of rows) {
    const key: any = `${row.chat_id}\0${row.message_id}`;
    const items: any = grouped.get(key) || [];
    items.push(row);
    grouped.set(key, items);
  }
  return grouped;
}

function buildChatShell(row?: any): any {
  return {
    id: row.id,
    name: row.name || "",
    note: row.note || "",
    folderId: row.folder_id ?? undefined,
    lastDate: row.last_message_time ?? undefined,
    message: [],
    messagesLoaded: false,
    messagesFullyLoaded: false,
    detailsLoaded: false,
  };
}

function createMessageRelations({
  attributes,
  generations,
  promptInfos,
  promptToggles,
  promptItems,
}: any): any {
  return {
    attributes: groupMessageRows(attributes),
    generation: new Map(
      generations.map((row?: any) => [
        `${row.chat_id}\0${row.message_id}`,
        row,
      ]),
    ),
    promptInfo: new Map(
      promptInfos.map((row?: any) => [
        `${row.chat_id}\0${row.message_id}`,
        row,
      ]),
    ),
    promptToggles: groupMessageRows(promptToggles),
    promptItems: groupMessageRows(promptItems),
  };
}

function createCharacterRelations({
  attributes,
  tags,
  greetings,
  biases,
  emotions,
  modules,
  groupMembers,
  chatFolders,
  scripts,
  sdData,
  assets,
  lore,
}: any): any {
  return {
    attributes: groupRows(attributes, "character_id"),
    tags: groupRows(tags, "character_id"),
    greetings: groupRows(greetings, "character_id"),
    biases: groupRows(biases, "character_id"),
    emotions: groupRows(emotions, "character_id"),
    modules: groupRows(modules, "character_id"),
    groupMembers: groupRows(groupMembers, "group_id"),
    chatFolders: groupRows(chatFolders, "character_id"),
    scripts: groupRows(scripts, "character_id"),
    sdData: groupRows(sdData, "character_id"),
    assets: groupRows(assets, "character_id"),
    lore: groupRows(lore, "character_id"),
  };
}

function createChatRelations({
  attributes,
  suggestions,
  modules,
  scriptState,
  bookmarks,
  memory,
  lore,
}: any): any {
  return {
    attributes: groupRows(attributes, "chat_id"),
    suggestions: groupRows(suggestions, "chat_id"),
    modules: groupRows(modules, "chat_id"),
    scriptState: groupRows(scriptState, "chat_id"),
    bookmarks: groupRows(bookmarks, "chat_id"),
    memory: groupRows(memory, "chat_id"),
    lore: groupRows(lore, "chat_id"),
  };
}

/** Reassembles normalized relational rows into the application database graph. */
function rebuildDatabaseGraph({
  database,
  characters,
  chats,
  messages = [],
  characterRelations,
  chatRelations,
  messageRelations = null,
  rebuildCharacter,
  rebuildChat,
  rebuildMessage,
  shallow = false,
}: any): any {
  const messagesByChat: any = new Map();
  if (!shallow && messageRelations) {
    for (const row of messages) {
      const key: any = `${row.chat_id}\0${row.id}`;
      const related: any = {
        attributes: messageRelations.attributes.get(key) || [],
        generation: messageRelations.generation.get(key) || null,
        promptInfo: messageRelations.promptInfo.get(key) || null,
        promptToggles: messageRelations.promptToggles.get(key) || [],
        promptItems: messageRelations.promptItems.get(key) || [],
      };
      const items: any = messagesByChat.get(row.chat_id) || [];
      items.push(rebuildMessage(row, related));
      messagesByChat.set(row.chat_id, items);
    }
  }

  const chatsByCharacter: any = new Map();
  for (const row of chats) {
    const related: any = { messages: messagesByChat.get(row.id) || [] };
    for (const [name, grouped] of Object.entries(chatRelations) as [
      string,
      any,
    ][]) {
      related[name] = grouped.get(row.id) || [];
    }
    const rebuilt: any = rebuildChat(row, related, { shallow });
    rebuilt.messagesLoaded = !shallow;
    rebuilt.detailsLoaded = !shallow;
    const items: any = chatsByCharacter.get(row.character_id) || [];
    items.push(rebuilt);
    chatsByCharacter.set(row.character_id, items);
  }

  database.characters = characters.map((row?: any) => {
    const related: any = { chats: chatsByCharacter.get(row.id) || [] };
    for (const [name, grouped] of Object.entries(characterRelations) as [
      string,
      any,
    ][]) {
      related[name] = grouped.get(row.id) || [];
    }
    const rebuilt: any = rebuildCharacter(row, related, { shallow });
    rebuilt.detailsLoaded = !shallow;
    return rebuilt;
  });
  return database;
}

export {
  DEFERRED_SETTING_KEYS,
  DEFERRED_STARTUP_SETTING_KEYS,
  PROMPT_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  DOMAIN_STORE_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  BOOTSTRAP_SETTING_KEYS,
  SqlStorageBase,
  createSqlStorageHelpers,
  groupRows,
  groupMessageRows,
  buildChatShell,
  createCharacterRelations,
  createChatRelations,
  createMessageRelations,
  rebuildDatabaseGraph,
  mergeLegacyModulesIntoPayload,
};
