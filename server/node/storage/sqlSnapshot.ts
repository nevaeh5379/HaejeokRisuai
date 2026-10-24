"use strict";

/**
 * One `exportDatabaseSnapshot()` for every vendor.
 *
 * The snapshot is a fixed list of `SELECT *` reads (`SNAPSHOT_TABLES`) plus the
 * same assembly: settings, modules, plugins, presets, plugin storage and the
 * character/chat/message graph. Only the statement text and the script
 * decoding differ, and those come from the dialect and the driver.
 * 스냅샷은 고정된 테이블 목록 조회와 동일한 조립으로 이루어지므로 한 번만
 * 구현하고, 문장은 방언이, 스크립트 디코딩은 드라이버가 제공합니다.
 */

import type { SqlDialect, SqlRow } from "./sqlDialect.ts";
import {
  buildChatShell,
  createCharacterRelations,
  createChatRelations,
  createMessageRelations,
  rebuildDatabaseGraph,
  rebuildPluginRecords,
} from "./sqlStorageCommon.ts";
import type {
  BotPresetDataRow,
  CharacterAttributeRow,
  CharacterBiasRow,
  CharacterChatFolderRow,
  CharacterCoreRow,
  CharacterEmotionRow,
  CharacterGreetingRow,
  CharacterGroupMemberRow,
  CharacterLoreRow,
  CharacterModuleRow,
  CharacterScriptRow,
  CharacterSdRow,
  CharacterTagRow,
  ChatAttributeRow,
  ChatBookmarkRow,
  ChatLoreRow,
  ChatMemoryRow,
  ChatModuleRow,
  ChatScriptStateRow,
  ChatSuggestionRow,
  MessageAttributeRow,
  MessageGenerationRow,
  MessagePromptInfoRow,
  MessagePromptItemRow,
  MessagePromptToggleRow,
  ModuleRecordRow,
  PluginRecordRow,
  PluginScriptRow,
  SettingScalarRow,
  SettingValueRow,
} from "./relationalRows.ts";
import { asRows, decodePresetData } from "./relationalRows.ts";
import {
  rebuildCharacter,
  rebuildChat,
  rebuildMessage,
} from "./postgres/postgresRelationalCodec.ts";
import { rebuildSettings } from "./postgres/postgresSettingsCodec.ts";
import { SNAPSHOT_TABLES } from "./sqlTables.ts";

/** Snapshot response shape shared by the three drivers. */
export type DatabaseSnapshot = {
  revision: number;
  initialized: boolean;
  database: SqlRow | null;
};

/** Driver-supplied pieces the shared snapshot cannot know about. */
export type SnapshotOptions = {
  /** Reads `revision`/`initialized` inside the same transaction. */
  readMeta: () => Promise<{ revision: number; initialized: boolean }>;
  /** Reads the author notes rows through the vendor's `authorNoteSql` adapter. */
  readAuthorNotes: () => Promise<SqlRow>;
  /**
   * Decodes a stored plugin script. Postgres encodes scripts; the other two
   * vendors store plain text.
   */
  decodeScript?: (value: unknown) => unknown;
};

/** Alias used by `rebuildSettings`: relation tables store `<x>_id AS setting_key`. */
function withSettingKey(rows: readonly SqlRow[], idColumn: string): SqlRow[] {
  return rows.map((row) => ({ ...row, setting_key: row[idColumn] }));
}

/**
 * Reads every snapshot table through the dialect and assembles the database.
 * The caller owns the transaction and the meta read so that the snapshot stays
 * consistent with the revision it reports.
 */
export async function exportDatabaseSnapshotWith(
  dialect: SqlDialect,
  options: SnapshotOptions,
): Promise<DatabaseSnapshot> {
  const { revision, initialized } = await options.readMeta();
  if (!initialized) {
    return { revision, initialized: false, database: null };
  }

  const rows = new Map<string, SqlRow[]>();
  for (const table of SNAPSHOT_TABLES) {
    rows.set(table, await dialect.selectOrdered(table));
  }
  const read = (table: string): SqlRow[] => rows.get(table) ?? [];

  const database: SqlRow = rebuildSettings(
    asRows<SettingScalarRow>(read("system.settings")),
    asRows<SettingValueRow>(read("system.setting_values")),
  );
  // Root settings that have no value rows still need their scalar column.
  for (const row of read("system.settings")) {
    const key = String(row.key);
    if (!Object.prototype.hasOwnProperty.call(database, key)) {
      database[key] = scalarSettingValue(row);
    }
  }

  Object.assign(database, await options.readAuthorNotes());
  // The JSON column arrives parsed from Postgres and as text from Oracle.
  database.pluginCustomStorage = Object.fromEntries(
    read("system.plugin_custom_storage").map((row) => [
      String(row.key),
      typeof row.value === "string" ? JSON.parse(row.value) : row.value,
    ]),
  );

  const moduleRecords = asRows<ModuleRecordRow>(read("system.module_records"));
  if (moduleRecords.length > 0) {
    const rebuiltModules = rebuildSettings(
      moduleRecords.map((row) => ({ key: row.module_id })),
      asRows<SettingValueRow>(
        withSettingKey(read("system.module_values"), "module_id"),
      ),
    );
    database.modules = moduleRecords.map((row) => ({
      ...decodePresetData(rebuiltModules[row.module_id]),
      id: row.module_id,
    }));
  } else {
    database.modules = database.modules || [];
  }

  const decodeScript = options.decodeScript ?? ((value: unknown) => value);
  const pluginScriptMap = new Map<string, unknown>(
    asRows<PluginScriptRow>(read("system.plugin_scripts")).map((row) => [
      row.plugin_id,
      decodeScript(row.script),
    ]),
  );
  database.plugins = rebuildPluginRecords(
    asRows<PluginRecordRow>(read("system.plugin_records")),
    asRows<SettingValueRow>(
      withSettingKey(read("system.plugin_values"), "plugin_id"),
    ),
  ).map((plugin) => {
    const { id, position: _position, ...metadata } = plugin;
    const script = pluginScriptMap.get(id);
    if (script === undefined) {
      throw new Error(`Plugin script is missing: ${id}`);
    }
    return { ...metadata, script };
  });

  const presetRows = asRows<BotPresetDataRow>(read("system.bot_presets"));
  if (presetRows.length > 0) {
    database.botPresets = presetRows.map((row) => {
      const { id: _id, ...rest } = decodePresetData(row.data);
      return rest;
    });
    const activeId = database.activeBotPresetId;
    database.botPresetsId = Math.max(
      0,
      presetRows.findIndex((row) => row.preset_id === activeId),
    );
  } else {
    database.botPresets = database.botPresets || [];
    database.botPresetsId = database.botPresetsId || 0;
  }

  const characterRelations = createCharacterRelations({
    attributes: asRows<CharacterAttributeRow>(read("character.attributes")),
    tags: asRows<CharacterTagRow>(read("character.tags")),
    greetings: asRows<CharacterGreetingRow>(read("character.greetings")),
    biases: asRows<CharacterBiasRow>(read("character.biases")),
    emotions: asRows<CharacterEmotionRow>(read("character.emotions")),
    modules: asRows<CharacterModuleRow>(read("character.modules")),
    groupMembers: asRows<CharacterGroupMemberRow>(
      read("character.group_members"),
    ),
    chatFolders: asRows<CharacterChatFolderRow>(read("character.chat_folders")),
    scripts: asRows<CharacterScriptRow>(read("character.scripts")),
    sdData: asRows<CharacterSdRow>(read("character.sd_data")),
    assets: asRows(read("character.assets")),
    lore: asRows<CharacterLoreRow>(read("character.lore_entries")),
  });
  const chatRelations = createChatRelations({
    attributes: asRows<ChatAttributeRow>(read("chat.attributes")),
    suggestions: asRows<ChatSuggestionRow>(read("chat.suggestions")),
    modules: asRows<ChatModuleRow>(read("chat.modules")),
    scriptState: asRows<ChatScriptStateRow>(read("chat.script_state")),
    bookmarks: asRows<ChatBookmarkRow>(read("chat.bookmarks")),
    memory: asRows<ChatMemoryRow>(read("chat.memory")),
    lore: asRows<ChatLoreRow>(read("chat.lore_entries")),
  });
  const messageRelations = createMessageRelations({
    attributes: asRows<MessageAttributeRow>(read("chat.message_attributes")),
    generations: asRows<MessageGenerationRow>(read("chat.message_generation")),
    promptInfos: asRows<MessagePromptInfoRow>(read("chat.message_prompt_info")),
    promptToggles: asRows<MessagePromptToggleRow>(
      read("chat.message_prompt_toggles"),
    ),
    promptItems: asRows<MessagePromptItemRow>(
      read("chat.message_prompt_items"),
    ),
  });

  rebuildDatabaseGraph({
    database,
    characters: asRows<CharacterCoreRow>(read("character.characters")),
    chats: asRows(read("chat.chats")),
    messages: asRows(read("chat.messages")),
    characterRelations,
    chatRelations,
    messageRelations,
    rebuildCharacter,
    rebuildChat,
    rebuildMessage,
  });

  return { revision, initialized: true, database };
}

/**
 * Decodes one scalar settings row. `updated_at` and other columns are ignored;
 * this is the same rule the drivers used for root settings without value rows.
 */
function scalarSettingValue(row: SqlRow): unknown {
  if (row.bool_val !== null && row.bool_val !== undefined) return row.bool_val;
  if (row.num_val !== null && row.num_val !== undefined) return row.num_val;
  if (row.text_val === null || row.text_val === undefined) return null;
  const text = String(row.text_val);
  if (text.startsWith("{") || text.startsWith("[") || text === "null") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Re-exported so drivers can build the empty shell without importing twice. */
export { buildChatShell };
