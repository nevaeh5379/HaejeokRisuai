"use strict";

import * as fs from "fs/promises";
import {
  createSqlCommitValidator,
  deriveSqlCommitImpact,
  readSqlCommitImpactSink,
} from "../../../packages/protocol/src/sqlCommit.ts";
import type {
  NormalizedSqlCommit,
  SqlSettingUpsert,
} from "../../../packages/protocol/src/sqlCommit.ts";
import type { PluginMetadata } from "../../../src/ts/plugins/pluginTypes.ts";
import type {
  ExternalSyncTransaction,
  PluginRecordRow,
  SettingValueRow,
  SyncOptions,
  SyncProgressCallback,
} from "./relationalRows.ts";
import { pluginApiVersion } from "./relationalRows.ts";
import { rebuildSettings } from "./postgres/postgresSettingsCodec.ts";

const DEFAULT_MAX_COLD_STORAGE_KEYS = 250000;
const MAX_COLD_STORAGE_CHATS_PER_CHARACTER = 100000;
const MAX_COLD_STORAGE_MESSAGES_PER_CHAT = 1000000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPAT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12}$/i;

import protocolSettings from "../../../packages/protocol/settings.ts";
const {
  DEFERRED_SETTING_KEYS,
  DEFERRED_STARTUP_SETTING_KEYS,
  PROMPT_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  DOMAIN_STORE_SETTING_KEYS,
  NON_SETTINGS_ROOT_KEYS,
  BOOTSTRAP_SETTING_KEYS,
} = protocolSettings;
const LEGACY_PERSONA_MIRROR_KEY_SET: ReadonlySet<string> = new Set(
  LEGACY_PERSONA_MIRROR_KEYS,
);
const SETTINGS_STORE_EXCLUDED_KEYS: readonly string[] = [
  ...new Set([...NON_SETTINGS_ROOT_KEYS, ...DOMAIN_STORE_SETTING_KEYS]),
];

/** A single row as returned by any of the supported SQL drivers. */
type SqlRow = Record<string, unknown>;
/** Rows of one related table, grouped by their owner key. */
type SqlRowGroups = Map<unknown, SqlRow[]>;
/** Related rows handed to a domain rebuild callback, keyed by relation name. */
type RelatedRows = Record<string, unknown>;
/** Legacy module object still stored inside the old `modules` root setting. */
type LegacyModuleRecord = SqlRow & { id: string };

function isRecord(value: unknown): value is SqlRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLegacyModule(value: unknown): value is LegacyModuleRecord {
  return isRecord(value) && typeof value.id === "string";
}

function mergeLegacyModulesIntoPayload(
  payload: NormalizedSqlCommit,
  legacyModules: unknown,
): void {
  if (!payload.modules || !Array.isArray(legacyModules)) return;
  const deleted = new Set<string>(payload.modules.deletes);
  const changed = new Set<string>(
    payload.modules.upserts.map((entry) => entry.id),
  );
  const inferredOrder: string[] = [
    ...legacyModules
      .filter(isLegacyModule)
      .map((module) => module.id)
      .filter((id) => !deleted.has(id)),
    ...payload.modules.upserts
      .map((entry) => entry.id)
      .filter((id) => !deleted.has(id)),
  ];
  const order: string[] = payload.modules.order || [...new Set(inferredOrder)];
  const positions = new Map<string, number>(
    order.map((id, position): [string, number] => [id, position]),
  );
  const migrated = legacyModules.flatMap((module: unknown) => {
    if (
      !isLegacyModule(module) ||
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

/** Settings snapshot plus its content hash, as each vendor returns it. */
type SettingSnapshot = { settings: SqlRow; hash: string };
/** Chat row as loaded by a vendor, with its message rows attached. */
type ChatGraph = SqlRow & { message: unknown[] };
type PluginsSnapshot = { plugins: PluginMetadata[]; hash: string };
type PluginCustomStorageSnapshot = {
  pluginCustomStorage: SqlRow;
  hash: string;
};
type ModuleSnapshot = { modules: SqlRow[]; hash: string };
type BootstrapSnapshot = { database: SqlRow; hash: string };
type SettingCollectionResult = SqlRow & { hash: string };
type SettingKeyResult = {
  key: string;
  value: unknown;
  exists: boolean;
  hash: string;
};

class SqlStorageBase {
  declare objectCacheEnabled: boolean;
  declare pluginsCache: PluginsSnapshot | null;
  declare pluginCustomStorageCache: PluginCustomStorageSnapshot | null;
  declare bootstrapCache: BootstrapSnapshot | null;
  declare bootstrapCachePromise: Promise<BootstrapSnapshot> | null;
  declare bootstrapCacheGeneration: number;
  declare enabled: boolean;

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

  invalidatePluginsCache(): void {
    this.pluginsCache = null;
  }

  invalidatePluginCustomStorageCache(): void {
    this.pluginCustomStorageCache = null;
  }

  invalidateBootstrapCache(changedKeys?: string[]): void {
    if (
      Array.isArray(changedKeys) &&
      !changedKeys.some((key) =>
        (BOOTSTRAP_SETTING_KEYS as readonly string[]).includes(key),
      )
    )
      return;
    this.bootstrapCacheGeneration += 1;
    this.bootstrapCache = null;
    this.bootstrapCachePromise = null;
  }

  async loadChatMessages(chatId?: string): Promise<unknown[]> {
    const chat = await this.loadChat(chatId);
    return chat ? chat.message : [];
  }

  async loadPluginsData(): Promise<
    PluginsSnapshot & PluginCustomStorageSnapshot
  > {
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

  async loadBootstrapData(): Promise<BootstrapSnapshot> {
    if (this.bootstrapCache) return this.bootstrapCache;
    if (this.bootstrapCachePromise != null) return this.bootstrapCachePromise;

    const generation = this.bootstrapCacheGeneration;
    const pending: Promise<BootstrapSnapshot> = this.loadSettingKeys(
      BOOTSTRAP_SETTING_KEYS,
    )
      .then(({ settings, hash }) => {
        const result: BootstrapSnapshot = { database: settings, hash };
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

  async warmBootstrapCache(): Promise<void> {
    if (!this.enabled) return;
    await this.loadBootstrapData();
  }

  async loadPersonas(): Promise<SettingCollectionResult> {
    return this.loadSettingCollection("personas", "personas");
  }

  async loadLorebooks(): Promise<SettingCollectionResult> {
    return this.loadSettingCollection("loreBook", "loreBook");
  }

  async loadModules(): Promise<SettingCollectionResult> {
    if (typeof this.loadModuleRecords === "function") {
      const records = await this.loadModuleRecords();
      if (records) return records;
    }
    return this.loadSettingCollection("modules", "modules");
  }

  async loadSettingCollection(
    settingKey: string,
    resultKey: string,
  ): Promise<SettingCollectionResult> {
    const { settings, hash } = await this.loadSettingKeys([settingKey]);
    return { [resultKey]: settings[settingKey] || [], hash };
  }

  async loadPrompts(): Promise<SettingCollectionResult> {
    const { settings, hash } = await this.loadSettingKeys(PROMPT_SETTING_KEYS);
    return { prompts: settings, hash };
  }

  async loadScripts(): Promise<SettingCollectionResult> {
    const { settings, hash } = await this.loadSettingKeys(["globalscript"]);
    return { globalscript: settings.globalscript || [], hash };
  }

  async loadSettingKey(key: string): Promise<SettingKeyResult> {
    const { settings, hash } = await this.loadSettingKeys([key]);
    return {
      key,
      value: settings[key] !== undefined ? settings[key] : null,
      exists: settings[key] !== undefined,
      hash,
    };
  }
}

// Vendor methods the shared base calls back into. They are declared by
// interface merging because a class field declaration would shadow the vendor
// implementation on the prototype at runtime.
interface SqlStorageBase {
  loadSettingKeys(keys: readonly string[]): Promise<SettingSnapshot>;
  loadPlugins(options?: { pluginId?: string }): Promise<PluginsSnapshot>;
  loadPluginCustomStorage(): Promise<PluginCustomStorageSnapshot>;
  loadChat(chatId?: string, options?: unknown): Promise<ChatGraph | null>;
  loadModuleRecords?(): Promise<ModuleSnapshot | null>;
}

/** Error constructor used to reject invalid payloads in the vendor dialect. */
type PayloadErrorConstructor = new (message: string) => Error;

interface SqlStorageHelperOptions {
  PayloadError: PayloadErrorConstructor;
  maxIdLength?: number;
  maxColdStorageKeys?: number;
  allowShortColdStorageKeys?: boolean;
  suppressLegacyReadErrors?: boolean;
}

/** A cold-storage chat object kept inside a character archive. */
type ColdStorageChat = SqlRow & { message?: SqlRow[] };
/** A cold-storage character object kept inside a character archive. */
type ColdStorageCharacter = SqlRow & { chats?: ColdStorageChat[] };
/** Record form of a cold-storage value; exactly one member is populated. */
type ColdStorageRecordValue = SqlRow & {
  character?: ColdStorageCharacter;
  message?: SqlRow[];
};
type ColdStorageValue = SqlRow[] | ColdStorageRecordValue;

/** One chat row derived from a cold-storage archive. */
type SplitColdStorageChat = {
  position: number;
  data: SqlRow;
  fields: string[];
};
/** One message row derived from a cold-storage archive. */
type SplitColdStorageMessage = {
  chatPosition: number;
  position: number;
  data: SqlRow;
  fields: string[];
};
type SplitColdStorageArchive = {
  chats: SplitColdStorageChat[];
  messages: SplitColdStorageMessage[];
  characterFields: string[];
};
type SplitColdStorageValue = SplitColdStorageArchive &
  (
    | { kind: "legacy"; data: SqlRow[] }
    | { kind: "character"; data: SqlRow & { character: SqlRow } }
    | { kind: "chat"; data: SqlRow }
  );

/** File left behind by the pre-relational cold-storage layout. */
type LegacyColdStorageFile = { filename: string; key: string };

interface SqlStorageHelpers {
  asArray(value: unknown, field?: string): unknown[];
  assertId(value: unknown, field?: string): asserts value is string;
  assertPosition(value: unknown, field?: string): asserts value is number;
  assertData(value: unknown, field?: string): asserts value is SqlRow;
  normalizeColdStorageKey(value: unknown, field?: string): string;
  validateColdStorageValue(value: unknown): ColdStorageValue;
  splitColdStorageValue(value: unknown): SplitColdStorageValue;
  validateColdStorageKeys(value: unknown, field?: string): string[];
  findLegacyColdStorageFiles(
    savePath: string,
  ): Promise<LegacyColdStorageFile[]>;
  validateSyncPayload(rawPayload: unknown): NormalizedSqlCommit;
  captureSyncCommitImpact(options: unknown, payload: NormalizedSqlCommit): void;
  dedupeRootUpserts<TPayload extends { rootUpserts: SqlSettingUpsert[] }>(
    payload: TPayload,
  ): TPayload;
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
}: SqlStorageHelperOptions): SqlStorageHelpers {
  if (typeof PayloadError !== "function") {
    throw new TypeError("PayloadError must be an error constructor");
  }

  const coldStorageKeyPattern = allowShortColdStorageKeys
    ? COMPAT_UUID_PATTERN
    : UUID_PATTERN;
  const coldStoragePathPattern = new RegExp(
    `^coldstorage/(${coldStorageKeyPattern.source.slice(1, -1)})$`,
    "i",
  );

  function asArray(value: unknown, field?: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value))
      throw new PayloadError(`${field} must be an array`);
    return value;
  }

  function assertId(value: unknown, field?: string): asserts value is string {
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

  function assertPosition(
    value: unknown,
    field?: string,
  ): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new PayloadError(`${field} must be a non-negative integer`);
    }
  }

  function assertData(
    row: unknown,
    field?: string,
  ): asserts row is SqlRow & { data: SqlRow } {
    const record = row as { data?: unknown };
    if (
      !row ||
      !Object.prototype.hasOwnProperty.call(row, "data") ||
      record.data === null ||
      typeof record.data !== "object" ||
      Array.isArray(record.data)
    ) {
      throw new PayloadError(`${field} must be a JSON object`);
    }
  }

  function normalizeColdStorageKey(
    value: unknown,
    field = "coldStorageKey",
  ): string {
    if (typeof value !== "string" || !coldStorageKeyPattern.test(value)) {
      throw new PayloadError(`${field} must be a UUID`);
    }
    return value.toLowerCase();
  }

  function validateColdStorageValue(value: unknown): ColdStorageValue {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) {
      throw new PayloadError(
        "Cold storage data must be an array or an object containing character or message data",
      );
    }
    if ("character" in value) {
      const character = value.character;
      if (
        !isRecord(character) ||
        (character.chats !== undefined && !Array.isArray(character.chats))
      ) {
        throw new PayloadError("Cold storage character data is invalid");
      }
      const chats = Array.isArray(character.chats) ? character.chats : [];
      if (chats.length > MAX_COLD_STORAGE_CHATS_PER_CHARACTER) {
        throw new PayloadError("Cold storage character has too many chats");
      }
      for (const chat of chats) {
        if (
          !isRecord(chat) ||
          (chat.message !== undefined && !Array.isArray(chat.message))
        ) {
          throw new PayloadError("Cold storage character chat data is invalid");
        }
        validateMessages(Array.isArray(chat.message) ? chat.message : []);
      }
      // The checks above are the whole contract of the record form.
      return value as ColdStorageRecordValue;
    }
    if (!("message" in value) || !Array.isArray(value.message)) {
      throw new PayloadError(
        "Cold storage data must be an array or an object containing character or message data",
      );
    }
    validateMessages(value.message);
    return value as ColdStorageRecordValue;
  }

  function validateMessages(messages: unknown[]): void {
    if (messages.length > MAX_COLD_STORAGE_MESSAGES_PER_CHAT) {
      throw new PayloadError("Cold storage chat has too many messages");
    }
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new PayloadError("Cold storage message data is invalid");
      }
    }
  }

  function splitColdStorageValue(rawValue: unknown): SplitColdStorageValue {
    const value = validateColdStorageValue(rawValue);
    if (Array.isArray(value)) {
      return {
        kind: "legacy",
        data: value,
        chats: [],
        messages: [],
        characterFields: [],
      };
    }
    if (value.character) {
      const { chats = [], ...characterData } = value.character;
      const normalizedChats: SplitColdStorageChat[] = [];
      const normalizedMessages: SplitColdStorageMessage[] = [];
      const chatCount = Math.min(
        chats.length,
        MAX_COLD_STORAGE_CHATS_PER_CHARACTER,
      );
      for (let chatPosition = 0; chatPosition < chatCount; chatPosition++) {
        const { message = [], ...chatData } = chats[chatPosition];
        normalizedChats.push({
          position: chatPosition,
          data: chatData,
          fields: Object.keys(chats[chatPosition]),
        });
        const messageCount = Math.min(
          message.length,
          MAX_COLD_STORAGE_MESSAGES_PER_CHAT,
        );
        for (
          let messagePosition = 0;
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
      messages: message.map((item, position) => ({
        chatPosition: 0,
        position,
        data: item,
        fields: Object.keys(item),
      })),
      characterFields: [],
    };
  }

  function validateColdStorageKeys(value: unknown, field = "keys"): string[] {
    const keys = asArray(value, field);
    if (keys.length > maxColdStorageKeys) {
      throw new PayloadError(
        `${field} exceeds the ${maxColdStorageKeys} key limit`,
      );
    }
    return Array.from(
      new Set(keys.map((key) => normalizeColdStorageKey(key, `${field}[]`))),
    );
  }

  async function findLegacyColdStorageFiles(
    savePath: string,
  ): Promise<LegacyColdStorageFile[]> {
    try {
      const entries = await fs.readdir(savePath, { withFileTypes: true });
      const candidates: LegacyColdStorageFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^(?:[0-9a-f]{2})+$/i.test(entry.name))
          continue;
        const logicalPath = Buffer.from(entry.name, "hex").toString("utf8");
        if (
          Buffer.from(logicalPath, "utf8").toString("hex") !==
          entry.name.toLowerCase()
        )
          continue;
        const match = logicalPath.match(coldStoragePathPattern);
        if (match)
          candidates.push({
            filename: entry.name,
            key: match[1].toLowerCase(),
          });
      }
      return candidates;
    } catch (error: unknown) {
      if (suppressLegacyReadErrors) return [];
      throw error;
    }
  }

  const validateProtocolSyncPayload = createSqlCommitValidator({
    PayloadError,
    maxIdLength,
  });
  const validateSyncPayload = (rawPayload: unknown): NormalizedSqlCommit => {
    const payload = validateProtocolSyncPayload(rawPayload);
    const legacyUpsert = payload.rootUpserts.find((upsert) =>
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
  const captureSyncCommitImpact = (
    options: unknown,
    payload: NormalizedSqlCommit,
  ): void => {
    const sink = readSqlCommitImpactSink(options);
    if (!sink) return;
    sink(deriveSqlCommitImpact(payload));
  };

  // Preset handling pushes `activeBotPresetId` into rootUpserts after
  // validation. Restores built from portable databases can already contain
  // that key, and a duplicated key makes the single-statement bulk upsert
  // fail with "ON CONFLICT DO UPDATE command cannot affect row a second
  // time" on PostgreSQL. Keep the last occurrence, matching ordinary
  // last-write-wins upsert semantics.
  const dedupeRootUpserts = <
    TPayload extends { rootUpserts: SqlSettingUpsert[] },
  >(
    payload: TPayload,
  ): TPayload => {
    const seen = new Set<string>();
    for (let index = payload.rootUpserts.length - 1; index >= 0; index--) {
      const key = payload.rootUpserts[index].key;
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

function groupRows<TRow extends SqlRow>(
  rows: readonly TRow[],
  key: string,
): Map<unknown, TRow[]> {
  const grouped = new Map<unknown, TRow[]>();
  for (const row of rows) {
    const id = (row as SqlRow)[key];
    const items = grouped.get(id) || [];
    items.push(row);
    grouped.set(id, items);
  }
  return grouped;
}

function groupMessageRows(rows: readonly SqlRow[]): Map<string, SqlRow[]> {
  const grouped = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const key = `${row.chat_id}\0${row.message_id}`;
    const items = grouped.get(key) || [];
    items.push(row);
    grouped.set(key, items);
  }
  return grouped;
}

/** Chat entry carrying only the columns of the chat shell query. */
type ChatShell = SqlRow & {
  message: SqlRow[];
  messagesLoaded: boolean;
  messagesFullyLoaded: boolean;
  detailsLoaded: boolean;
};

function buildChatShell(row: SqlRow): ChatShell {
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

type CharacterRelationRows = {
  attributes: readonly SqlRow[];
  tags: readonly SqlRow[];
  greetings: readonly SqlRow[];
  biases: readonly SqlRow[];
  emotions: readonly SqlRow[];
  modules: readonly SqlRow[];
  groupMembers: readonly SqlRow[];
  chatFolders: readonly SqlRow[];
  scripts: readonly SqlRow[];
  sdData: readonly SqlRow[];
  assets: readonly SqlRow[];
  lore: readonly SqlRow[];
};
type CharacterRowGroups = Record<keyof CharacterRelationRows, SqlRowGroups>;

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
}: CharacterRelationRows): CharacterRowGroups {
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

type ChatRelationRows = {
  attributes: readonly SqlRow[];
  suggestions: readonly SqlRow[];
  modules: readonly SqlRow[];
  scriptState: readonly SqlRow[];
  bookmarks: readonly SqlRow[];
  memory: readonly SqlRow[];
  lore: readonly SqlRow[];
};
type ChatRowGroups = Record<keyof ChatRelationRows, SqlRowGroups>;

function createChatRelations({
  attributes,
  suggestions,
  modules,
  scriptState,
  bookmarks,
  memory,
  lore,
}: ChatRelationRows): ChatRowGroups {
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

type MessageRelationRows = {
  attributes: readonly SqlRow[];
  generations: readonly SqlRow[];
  promptInfos: readonly SqlRow[];
  promptToggles: readonly SqlRow[];
  promptItems: readonly SqlRow[];
};
type MessageRowGroups = {
  attributes: SqlRowGroups;
  generation: Map<string, SqlRow>;
  promptInfo: Map<string, SqlRow>;
  promptToggles: SqlRowGroups;
  promptItems: SqlRowGroups;
};

function createMessageRelations({
  attributes,
  generations,
  promptInfos,
  promptToggles,
  promptItems,
}: MessageRelationRows): MessageRowGroups {
  const messageKey = (row: SqlRow) => `${row.chat_id}\0${row.message_id}`;
  return {
    attributes: groupMessageRows(attributes),
    generation: new Map(
      generations.map((row): [string, SqlRow] => [messageKey(row), row]),
    ),
    promptInfo: new Map(
      promptInfos.map((row): [string, SqlRow] => [messageKey(row), row]),
    ),
    promptToggles: groupMessageRows(promptToggles),
    promptItems: groupMessageRows(promptItems),
  };
}

/** Rebuilds one message, chat, or character row from its related rows. */
type RebuildRow = (
  row: SqlRow,
  related: RelatedRows,
  options?: { shallow: boolean },
) => SqlRow;

interface RebuildDatabaseGraphOptions {
  database: SqlRow;
  characters: readonly SqlRow[];
  chats: readonly SqlRow[];
  messages?: readonly SqlRow[];
  characterRelations: Record<string, SqlRowGroups>;
  chatRelations: Record<string, SqlRowGroups>;
  messageRelations?: MessageRowGroups | null;
  rebuildCharacter: RebuildRow;
  rebuildChat: RebuildRow;
  rebuildMessage: RebuildRow;
  shallow?: boolean;
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
}: RebuildDatabaseGraphOptions): SqlRow {
  const messagesByChat = new Map<string, SqlRow[]>();
  if (!shallow && messageRelations) {
    for (const row of messages) {
      const key = `${row.chat_id}\0${row.id}`;
      const related: RelatedRows = {
        attributes: messageRelations.attributes.get(key) || [],
        generation: messageRelations.generation.get(key) || null,
        promptInfo: messageRelations.promptInfo.get(key) || null,
        promptToggles: messageRelations.promptToggles.get(key) || [],
        promptItems: messageRelations.promptItems.get(key) || [],
      };
      const items = messagesByChat.get(String(row.chat_id)) || [];
      items.push(rebuildMessage(row, related));
      messagesByChat.set(String(row.chat_id), items);
    }
  }

  const chatsByCharacter = new Map<string, SqlRow[]>();
  for (const row of chats) {
    const related: RelatedRows = {
      messages: messagesByChat.get(String(row.id)) || [],
    };
    for (const [name, grouped] of Object.entries(chatRelations)) {
      related[name] = grouped.get(row.id) || [];
    }
    const rebuilt = rebuildChat(row, related, { shallow });
    rebuilt.messagesLoaded = !shallow;
    rebuilt.detailsLoaded = !shallow;
    const items = chatsByCharacter.get(String(row.character_id)) || [];
    items.push(rebuilt);
    chatsByCharacter.set(String(row.character_id), items);
  }

  database.characters = characters.map((row) => {
    const related: RelatedRows = {
      chats: chatsByCharacter.get(String(row.id)) || [],
    };
    for (const [name, grouped] of Object.entries(characterRelations)) {
      related[name] = grouped.get(row.id) || [];
    }
    const rebuilt = rebuildCharacter(row, related, { shallow });
    rebuilt.detailsLoaded = !shallow;
    return rebuilt;
  });
  return database;
}

// ---------------------------------------------------------------------------
// Vendor-neutral row mappers
//
// Every SQL vendor stores the same logical row, so anything that is not a
// dialect decision belongs here instead of in three near-identical copies.
// 벤더마다 같은 논리적 행을 저장하므로, 방언 판단이 아닌 변환은 여기서 한 번만
// 구현합니다.
// ---------------------------------------------------------------------------

/** Extension columns of one `system.plugin_values`-backed plugin record. */
function pluginExtensionData(data: unknown): SqlRow {
  const source = isRecord(data) ? data : {};
  return {
    arguments: source.arguments || {},
    realArg: source.realArg || {},
    customLink: source.customLink || [],
    argMeta: source.argMeta || {},
    allowedIPC: source.allowedIPC || [],
  };
}

/** Rebuilds plugin metadata from its record rows and extension values. */
function rebuildPluginRecords(
  records: readonly PluginRecordRow[],
  valueRows: readonly SettingValueRow[],
): PluginMetadata[] {
  const extension: SqlRow = rebuildSettings(
    records.map((row) => ({ key: row.plugin_id })),
    valueRows,
  );
  return records.map((row) => {
    const stored = extension[row.plugin_id] as
      Partial<PluginMetadata> | undefined;
    return {
      arguments: {},
      realArg: {},
      customLink: [],
      argMeta: {},
      ...(stored ?? {}),
      id: row.plugin_id,
      position: Number(row.position),
      name: row.name,
      displayName: row.display_name ?? undefined,
      version: pluginApiVersion(row.api_version),
      versionOfPlugin: row.plugin_version ?? undefined,
      updateURL: row.update_url ?? undefined,
      enabled: Boolean(row.enabled),
    };
  });
}

/** Pattern the database explorer accepts for table and column names. */
const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds the database-explorer identifier validator around a vendor's payload
 * error type and wording.
 * 벤더마다 에러 타입과 문구만 다르므로 검증 규칙은 공용으로 둡니다.
 */
function createDbExplorerIdentifierValidator(options: {
  PayloadError: new (message?: string) => Error;
  tooLong: (field: string) => string;
  invalid: (field: string) => string;
}): (value: unknown, field: string) => string {
  return (value, field) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 128) {
      throw new options.PayloadError(options.tooLong(field));
    }
    const parts = value.split(".");
    if (parts.length === 1 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0])) {
      return value;
    }
    if (
      parts.length === 2 &&
      DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0]) &&
      DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[1])
    ) {
      return value;
    }
    throw new options.PayloadError(options.invalid(field));
  };
}

/** Scalar columns shared by every vendor's settings row. */
type ScalarSettingColumns<TBoolean> = {
  text_val: string | null;
  num_val: number | null;
  bool_val: TBoolean | null;
};

/** Scalar settings row shared by every vendor, with a vendor boolean column. */
type ScalarSettingRow<TBoolean> = ScalarSettingColumns<TBoolean> & {
  key: string;
};

/**
 * Builds the scalar setting column mappers around a vendor's boolean encoding.
 * Vendors only differ in how `bool_val` is stored, so the decoding rules —
 * including the legacy JSON text form — live here.
 * 벤더는 `bool_val` 저장 방식만 다르므로, 레거시 JSON 텍스트 형식 해석을 포함한
 * 나머지 규칙은 공용으로 둡니다.
 */
function createSettingColumnMappers<TBoolean>(options: {
  encodeBool: (value: boolean) => TBoolean;
  decodeBool: (value: TBoolean) => unknown;
  /** Drivers that hand `num_val` back as a string need `Number`. */
  decodeNumber?: (value: number) => unknown;
}) {
  function mapSettingValueToColumns(
    value: unknown,
  ): ScalarSettingColumns<TBoolean> {
    if (typeof value === "boolean") {
      return {
        text_val: null,
        num_val: null,
        bool_val: options.encodeBool(value),
      };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return { text_val: null, num_val: value, bool_val: null };
    }
    if (typeof value === "string") {
      return { text_val: value, num_val: null, bool_val: null };
    }
    return { text_val: null, num_val: null, bool_val: null };
  }

  function mapColumnsToSettingValue(
    row: Omit<ScalarSettingRow<TBoolean>, "key">,
  ): unknown {
    if (row.bool_val !== null) return options.decodeBool(row.bool_val);
    if (row.num_val !== null) {
      return options.decodeNumber
        ? options.decodeNumber(row.num_val)
        : row.num_val;
    }
    if (row.text_val === null) return null;
    const text = row.text_val;
    if (text.startsWith("{") || text.startsWith("[") || text === "null") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  return { mapSettingValueToColumns, mapColumnsToSettingValue };
}

// ---------------------------------------------------------------------------
// Vendor-neutral sync helpers
//
// `sync()` differs between vendors only in SQL dialect. Option parsing, cache
// invalidation and the result shape are the same everywhere, so they live here.
// 세 벤더의 `sync()`는 SQL 방언만 다르므로, 방언과 무관한 처리는 여기서 한 번만
// 구현합니다.
// ---------------------------------------------------------------------------

/** Progress sink of `sync`, accepting both the legacy and current option form. */
function readSyncProgress(
  options: SyncOptions | SyncProgressCallback,
): SyncProgressCallback | null {
  const candidate =
    typeof options === "function"
      ? options
      : isRecord(options)
        ? options.onProgress
        : null;
  return typeof candidate === "function"
    ? (candidate as SyncProgressCallback)
    : null;
}

/** Reused transaction context supplied by the storage-sync importer. */
function readExternalTransaction<TClient>(
  options: SyncOptions | SyncProgressCallback,
): ExternalSyncTransaction<TClient> | null {
  if (typeof options !== "object" || options === null) return null;
  const candidate = (options as Record<string, unknown>).externalTransaction;
  return isRecord(candidate)
    ? (candidate as ExternalSyncTransaction<TClient>)
    : null;
}

/** Chats whose message rows changed in this sync, for `last_message_time`. */
function collectAffectedMessageChatIds(payload: {
  messages?: readonly { chatId: string }[];
  messageDeletes?: readonly { chatId: string }[];
}): Set<string> {
  return new Set<string>([
    ...(payload.messages || []).map((item) => item.chatId),
    ...(payload.messageDeletes || []).map((item) => item.chatId),
  ]);
}

/** Author-note summary carried by the sync result and the stored receipt. */
function summarizeAuthorNotes<
  TNote extends { id: string; contentHash: string; updatedAt: unknown },
>(
  authorNotes: readonly TNote[],
): { id: string; contentHash: string; updatedAt: TNote["updatedAt"] }[] {
  return authorNotes.map(({ id, contentHash, updatedAt }) => ({
    id,
    contentHash,
    updatedAt,
  }));
}

/** Cache invalidations implied by an already committed sync payload. */
function resolveSyncCacheInvalidation(payload: {
  plugins?: unknown;
  rootUpserts?: readonly { key: string }[];
  rootDeletes?: readonly string[];
}): {
  plugins: boolean;
  pluginCustomStorage: boolean;
  bootstrapKeys: string[];
} {
  const changedKeys = (payload.rootUpserts || []).map((row) => row.key);
  const rootDeletes = payload.rootDeletes || [];
  return {
    plugins:
      Boolean(payload.plugins) ||
      changedKeys.includes("plugins") ||
      rootDeletes.includes("plugins"),
    pluginCustomStorage:
      changedKeys.includes("pluginCustomStorage") ||
      rootDeletes.includes("pluginCustomStorage"),
    bootstrapKeys: [...changedKeys, ...rootDeletes],
  };
}

/** Drops the caches a committed sync payload invalidated. */
function invalidateSyncCaches(
  storage: SqlStorageBase,
  payload: Parameters<typeof resolveSyncCacheInvalidation>[0],
): void {
  const invalidation = resolveSyncCacheInvalidation(payload);
  if (invalidation.plugins) storage.invalidatePluginsCache();
  if (invalidation.pluginCustomStorage) {
    storage.invalidatePluginCustomStorageCache();
  }
  storage.invalidateBootstrapCache(invalidation.bootstrapKeys);
}

/** Compact change counts reported by `sync`. */
type SyncChangeCounts = {
  root: number;
  characters: number;
  chats: number;
  messages: number;
};

/** Author-note summary carried by the sync result and the stored receipt. */
type AuthorNoteSummary<TNote extends { updatedAt: unknown }> = {
  id: string;
  contentHash: string;
  updatedAt: TNote["updatedAt"];
};

/** Standard `sync` result: revision, author-note summary, change counts. */
type SyncResult<TNote extends { updatedAt: unknown }> = {
  revision: number;
  authorNotes: AuthorNoteSummary<TNote>[];
  changed: SyncChangeCounts;
} & Record<string, unknown>;

/** Standard `sync` result with the compact change counts clients read. */
function buildSyncResult<
  TNote extends { id: string; contentHash: string; updatedAt: unknown },
>(options: {
  payload: {
    rootUpserts: readonly unknown[];
    rootDeletes: readonly unknown[];
    characters?: readonly unknown[];
    chats?: readonly unknown[];
    messages?: readonly unknown[];
  };
  revision: number;
  authorNotes: readonly TNote[];
  extra?: Record<string, unknown>;
}): SyncResult<TNote> {
  const { payload } = options;
  return {
    revision: options.revision,
    authorNotes: summarizeAuthorNotes(options.authorNotes),
    changed: {
      root: payload.rootUpserts.length + payload.rootDeletes.length,
      characters: (payload.characters || []).length,
      chats: (payload.chats || []).length,
      messages: (payload.messages || []).length,
    },
    ...(options.extra ?? {}),
  };
}

/**
 * Standard `sync` result for vendors that do not report change counts.
 * 변경 카운트를 보고하지 않는 벤더용 변형입니다.
 */
function buildRevisionResult<
  TNote extends { id: string; contentHash: string; updatedAt: unknown },
>(options: {
  revision: number;
  authorNotes: readonly TNote[];
  extra?: Record<string, unknown>;
}): { revision: number; authorNotes: AuthorNoteSummary<TNote>[] } & Record<
  string,
  unknown
> {
  return {
    revision: options.revision,
    authorNotes: summarizeAuthorNotes(options.authorNotes),
    ...(options.extra ?? {}),
  };
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
  pluginExtensionData,
  rebuildPluginRecords,
  createSettingColumnMappers,
  createDbExplorerIdentifierValidator,
  readSyncProgress,
  readExternalTransaction,
  collectAffectedMessageChatIds,
  summarizeAuthorNotes,
  resolveSyncCacheInvalidation,
  invalidateSyncCaches,
  buildSyncResult,
  buildRevisionResult,
};

export type {
  SqlStorageHelpers,
  ScalarSettingColumns,
  ScalarSettingRow,
  SyncChangeCounts,
  SyncResult,
};
