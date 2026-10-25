// Relational row types shared by the SQL storage drivers.
//
// The relational schema (`postgres-schema.sql`, `oracle-schema.sql`,
// `azure-schema.sql`) declares the same logical columns in every dialect, and
// all vendors decode through the same codecs, so the in-memory row shapes live
// here instead of being restated per driver.
//
// 관계형 스키마는 벤더별로 같은 논리 컬럼을 선언하고 모든 벤더가 같은 codec을
// 사용하므로, 메모리 상의 행 타입은 드라이버마다 반복하지 않고 여기서 공유합니다.

import type { PluginMetadata } from "../../../src/ts/plugins/pluginTypes.ts";
import { SETTING_RELATION_DEFINITIONS as RAW_SETTING_RELATION_DEFINITIONS } from "./postgres/postgresSettingRelations.ts";

/** A single row as returned by any of the supported SQL drivers. */
export type SqlStorageRow = Record<string, unknown>;

/** One projected setting relation table declared by the settings codec. */
export type SettingRelationDefinition = {
  table: string;
  columns: string[];
  types: string[];
  settingKeys: string[];
};
/**
 * Typed view of the setting relation definitions. The codec exports them
 * untyped because it builds each table from the setting projection, so every
 * driver narrows them once here instead of restating the shape.
 */
export const SETTING_RELATION_DEFINITIONS: readonly SettingRelationDefinition[] =
  RAW_SETTING_RELATION_DEFINITIONS;
/** Table names of the projected setting relations, in codec order. */
export const SETTING_RELATION_TABLES: readonly string[] =
  SETTING_RELATION_DEFINITIONS.map((definition) => definition.table);

/** Row of `system.settings`; exactly one value column is populated. */
export type SettingScalarRow = {
  key: string;
  text_val: string | null;
  num_val: number | null;
  bool_val: boolean | null;
};

/** Row of `system.plugin_records`. */
export type PluginRecordRow = {
  plugin_id: string;
  position: number | string;
  name: string;
  display_name: string | null;
  api_version: string | null;
  plugin_version: string | null;
  update_url: string | null;
  enabled: boolean | null;
};

/** Row of `system.plugin_scripts`. */
export type PluginScriptRow = { plugin_id: string; script: unknown };

/** Row of `system.bot_presets` including the stored preset payload. */
export type BotPresetDataRow = {
  preset_id: string;
  position: number | string;
  name: string | null;
  image: string | null;
  api_type: string | null;
  ai_model: string | null;
  data: unknown;
  content_hash: string | null;
};

/** Row of a `system.setting_values`-style flattened value table. */
export type SettingValueRow = {
  setting_key: string;
  node_id: number;
  parent_node_id: number | null;
  member_key: string | null;
  encoded_member_key: string | null;
  position: number | null;
  value_type: string;
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
};

/**
 * Attribute row of a character, chat, archive or message. The owner id column
 * is attached by the writer, so it is absent from the split output.
 */
export type AttributeRow = { key: string; value: unknown };

/** Row of `character.characters`; absent scalars stay unset for the writer. */
export type CharacterCoreRow = {
  id: string;
  position: number;
  kind: "character" | "group";
  name: string;
  first_message: string;
  chat_page: number;
  image?: string | null;
  description?: string | null;
  notes?: string | null;
  creator_notes?: string | null;
  system_prompt?: string | null;
  post_history_instructions?: string | null;
  personality?: string | null;
  scenario?: string | null;
  example_message?: string | null;
  creator?: string | null;
  character_version?: string | null;
  nickname?: string | null;
  view_screen?: string | null;
  first_message_index?: number | null;
  utility_bot?: boolean | null;
  is_private?: boolean | null;
  realm_id?: string | null;
  license?: string | null;
  default_variables?: string | null;
  additional_text?: string | null;
  translator_note?: string | null;
  background_html?: string | null;
  background_css?: string | null;
  creation_time?: number | null;
  modification_time?: number | null;
  last_interaction_time?: number | null;
  trash_time?: number | null;
};

/** Row of `character.attributes`. */
export type CharacterAttributeRow = {
  character_id: string;
  key: string;
  value: unknown;
};

/** Row of `character.tags`. */
export type CharacterTagRow = {
  character_id: string;
  position: number;
  tag: string;
};

/** Row of `character.greetings`. */
export type CharacterGreetingRow = {
  character_id: string;
  greeting_type: "alternate" | "group-only";
  position: number;
  content: string;
};

/** Row of `character.biases`. */
export type CharacterBiasRow = {
  character_id: string;
  position: number;
  phrase: string;
  bias: number;
};

/** Row of `character.emotions`. */
export type CharacterEmotionRow = {
  character_id: string;
  position: number;
  emotion: string;
  asset: string;
};

/** Row of `character.modules`. */
export type CharacterModuleRow = {
  character_id: string;
  position: number;
  module_id: string;
};

/** Row of `character.group_members`. */
export type CharacterGroupMemberRow = {
  group_id: string;
  position: number;
  character_id: string;
  talk_weight: number | null;
  active: boolean | null;
};

/** Row of `character.chat_folders`. */
export type CharacterChatFolderRow = {
  character_id: string;
  position: number;
  folder_id: string;
  name: string | null;
  color: string | null;
  folded: boolean;
};

/** Row of `character.scripts`. */
export type CharacterScriptRow = {
  character_id: string;
  script_kind: "custom" | "trigger";
  position: number;
  comment: string | null;
  input_text: string | null;
  output_text: string | null;
  script_type: string | null;
  flag: string | null;
  able_flag: boolean | null;
  trigger_payload: unknown;
};

/** Row of `character.sd_data`. */
export type CharacterSdRow = {
  character_id: string;
  position: number;
  key: string;
  value: string;
};

/** Row of `character.assets`. */
export type CharacterAssetRow = {
  character_id: string;
  position: number;
  asset_source: "additional" | "character-card";
  asset_type: string | null;
  uri: string | null;
  name: string | null;
  extension: string | null;
  extra_value: string | null;
};

/** Lore columns shared by `character.lore_entries` and `chat.lore_entries`. */
export type LoreEntryColumns = {
  position: number;
  lore_id: string | null;
  primary_key: string;
  secondary_key: string;
  insert_order: number;
  comment: string;
  content: string;
  mode: string;
  always_active: boolean;
  selective: boolean;
  case_sensitive: boolean | null;
  activation_percent: number | null;
  use_regex: boolean | null;
  book_version: number | null;
  folder: string | null;
  cache_payload: unknown;
};

/** Row of `character.lore_entries`. */
export type CharacterLoreRow = LoreEntryColumns & { character_id: string };

/** Row of `chat.lore_entries`. */
export type ChatLoreRow = LoreEntryColumns & { chat_id: string };

/** Columns read for the chat shell listing of one character. */
export type ChatShellRow = {
  id: string;
  name: string | null;
  note: string | null;
  folder_id: string | null;
  last_message_time: number | string | null;
};

/** Row of `chat.chats`; absent scalars stay unset for the writer. */
export type ChatCoreRow = {
  id: string;
  character_id: string;
  position: number;
  name: string;
  note: string;
  sd_data?: string | null;
  supa_memory_data?: string | null;
  last_memory?: string | null;
  is_streaming?: boolean | null;
  streaming_optimization_mode?: string | null;
  bound_persona_id?: string | null;
  first_message_index?: number | null;
  folder_id?: string | null;
  last_message_time?: number | null;
};

/** Row of `chat.attributes`. */
export type ChatAttributeRow = {
  chat_id: string;
  key: string;
  value: unknown;
};

/** Row of `chat.suggestions`. */
export type ChatSuggestionRow = {
  chat_id: string;
  position: number;
  content: string;
};

/** Row of `chat.modules`. */
export type ChatModuleRow = {
  chat_id: string;
  position: number;
  module_id: string;
};

/** Row of `chat.script_state`; exactly one value column is populated. */
export type ChatScriptStateRow = {
  chat_id: string;
  key: string;
  value_type: "text" | "number" | "boolean";
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
};

/** Row of `chat.bookmarks`. */
export type ChatBookmarkRow = {
  chat_id: string;
  position: number;
  message_id: string;
  name: string | null;
};

/** Row of `chat.memory`. */
export type ChatMemoryRow = {
  chat_id: string;
  memory_type: string;
  payload: unknown;
};

/** Row of `chat.messages`; exactly one content column is populated. */
export type MessageCoreRow = {
  chat_id: string;
  id: string;
  position: number;
  role: "user" | "char";
  content_text: string | null;
  content_binary: Buffer | null;
  saying_character_id: string | null;
  sent_time: number | null;
  sender_name: string | null;
  other_user: boolean | null;
  disabled_scope: string | null;
  is_comment: boolean | null;
};

/** Row of `chat.message_attributes`. */
export type MessageAttributeRow = {
  chat_id: string;
  message_id: string;
  key: string;
  value: unknown;
};

/** Row of `chat.message_generation`. */
export type MessageGenerationRow = {
  chat_id: string;
  message_id: string;
  model: string | null;
  generation_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  max_context: number | null;
  stage1_time: number | null;
  stage2_time: number | null;
  stage3_time: number | null;
  stage4_time: number | null;
};

/** Row of `chat.message_prompt_info`. */
export type MessagePromptInfoRow = {
  chat_id: string;
  message_id: string;
  prompt_name: string | null;
};

/** Row of `chat.message_prompt_toggles`. */
export type MessagePromptToggleRow = {
  chat_id: string;
  message_id: string;
  position: number;
  toggle_key: string;
  toggle_value: string | null;
};

/** Row of `chat.message_prompt_items`. */
export type MessagePromptItemRow = {
  chat_id: string;
  message_id: string;
  position: number;
  payload: unknown;
};

/** Rows produced by `splitCharacter`, one entry per character relation. */
export type CharacterSplit = {
  core: CharacterCoreRow;
  attributes: AttributeRow[];
  tags: CharacterTagRow[];
  greetings: CharacterGreetingRow[];
  biases: CharacterBiasRow[];
  emotions: CharacterEmotionRow[];
  modules: CharacterModuleRow[];
  groupMembers: CharacterGroupMemberRow[];
  chatFolders: CharacterChatFolderRow[];
  scripts: CharacterScriptRow[];
  sdData: CharacterSdRow[];
  assets: CharacterAssetRow[];
  lore: CharacterLoreRow[];
};

/** Character relations other than the scalar core row. */
export type CharacterRelationName = Exclude<keyof CharacterSplit, "core">;

/** Rows produced by `splitChat`, one entry per chat relation. */
export type ChatSplit = {
  core: ChatCoreRow;
  attributes: AttributeRow[];
  suggestions: ChatSuggestionRow[];
  modules: ChatModuleRow[];
  scriptState: ChatScriptStateRow[];
  bookmarks: ChatBookmarkRow[];
  memory: ChatMemoryRow[];
  lore: ChatLoreRow[];
};

/** Chat relations other than the scalar core row. */
export type ChatRelationName = Exclude<keyof ChatSplit, "core">;

/** Prompt rows attached to one message. */
export type MessagePromptSplit = {
  info: MessagePromptInfoRow;
  toggles: MessagePromptToggleRow[];
  items: MessagePromptItemRow[];
};

/** Rows produced by `splitMessage`. */
export type MessageSplit = {
  core: MessageCoreRow;
  attributes: AttributeRow[];
  generation: MessageGenerationRow | null;
  prompt: MessagePromptSplit | null;
};

/** Owner key plus either the retained row lengths or the retained row keys. */
export type PositionalOwnerLength = {
  ownerId: string;
  length: number;
  subKind?: string | null;
};

/** Owner key plus the retained child keys, used when pruning keyed rows. */
export type KeyedOwnerKeys = {
  ownerId: string;
  keys: readonly string[] | null;
};

/** Column of an audited table, read back from `pg_attribute`. */
export type RestoreColumn = { name: string; type: string; notNull: boolean };

/** Columns and primary key of one restartable table. */
export type RestoreTable = { columns: RestoreColumn[]; primary: string[] };

export type RestoreMetadataRow = {
  table_name: string;
  column_name: string;
  column_type: string;
  ordinal: number;
  not_null: boolean;
  is_primary: boolean;
};

/** One `system.revisions` row. */
export type RevisionRow = {
  id: number | string;
  storage_revision: number | string | null;
  database_initialized: boolean | null;
  scope: string | null;
  action: string | null;
  restored_from_revision: number | string | null;
  created_at: string | Date;
};

/** `system.revisions` row joined with its audit change count. */
export type RevisionListRow = RevisionRow & { change_count: number | string };

/** One `system.audit_log` row. */
export type AuditLogEntryRow = {
  sequence: number | string;
  revision_id: number | string;
  table_name: string;
  operation: string;
  before_row: unknown;
  after_row: unknown;
  recorded_at: string | Date;
};

/** One audited change reported by `getRevisionDiff`. */
export type RevisionDiffEntry = {
  sequence: number;
  revisionId: number;
  tableName: string;
  operation: string;
  beforeRow: unknown;
  afterRow: unknown;
  recordedAt: string | Date;
};

/** Per-table counters used by the revision and restore previews. */
export type RevisionTableSummary = {
  tableName: string;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  totalCount: number;
};

/** Per-table counters reported by `previewRestore`. */
export type RestorePreviewSummary = {
  tableName: string;
  revertedInserts: number;
  revertedUpdates: number;
  revertedDeletes: number;
  totalChanges: number;
};

/** Single entry of a system asset catalog batch. */
export type AssetCatalogEntry = {
  key: string;
  size?: number | null;
  etag?: string | null;
};

/** One `system.bot_presets` listing row. */
export type BotPresetListRow = {
  preset_id: string;
  position: number | string;
  name: string | null;
  image: string | null;
  api_type: string | null;
  ai_model: string | null;
  content_hash: string | null;
};

/** Recent-chat listing row. */
export type RecentChatRow = {
  character_id: string;
  character_name: string | null;
  character_image: string | null;
  character_kind: string | null;
  chat_id: string;
  chat_position: number | string | null;
  chat_name: string | null;
  folder_id: string | null;
  last_message_time: number | string | null;
  last_message_text: string | null;
};

/** Full-text message search row. */
export type MessageSearchRow = {
  storage_state: string;
  archive_id: string | null;
  character_id: string | null;
  character_name: string | null;
  chat_id: string | null;
  chat_name: string;
  message_id: string;
  position: number | string;
  role: string;
  sent_time: number | string | null;
  sender_name: string | null;
  snippet: string | null;
};

/** Token usage aggregation row. */
export type TokenUsageRow = {
  model: string;
  message_count: number | string;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
};

/** Bot chat statistics row. */
export type BotChatStatsRow = {
  id: string;
  name: string | null;
  image: string | null;
  kind: string | null;
  total_sessions: number | string | null;
  total_messages: number | string | null;
  user_messages: number | string | null;
  bot_messages: number | string | null;
  longest_session_messages: number | string | null;
  last_active_date: number | string | null;
  avg_bot_message_len: number | string | null;
  avg_user_message_len: number | string | null;
};

/** Character summary returned by the character searches. */
export type CharacterSummaryRow = {
  id: string;
  name: string | null;
  image: string | null;
  kind: string | null;
};

/** Column of the storage explorer. */
export type ExplorerColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
};

/** Raw `information_schema.columns` row of the storage explorer. */
export type ExplorerColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
};

/** Paging options of the branch message loaders. */
export type BranchPageOptions = {
  before?: unknown;
  limit?: unknown;
  mode?: string;
};

/** Options of `loadChat` and `loadBranchMessages`. */
export type LoadChatOptions = {
  messageLimit?: number | string | null;
  mode?: string;
};

/** Message ids removed from one chat, used to repair the branch graph. */
export type MessageDeletion = { chatId: string; ids?: readonly string[] };

/** Row written to `chat.branches` by the storage-sync importer. */
export type ChatBranchInsertRow = {
  chat_id: string;
  id: string;
  parent_branch_id: string | null;
  fork_message_id: string | null;
  head_message_id: string | null;
  reason: string;
  created_at: number;
};

/** One `chat.branches` row, optionally joined with the active branch. */
export type BranchRow = {
  id: string;
  chat_id: string;
  parent_branch_id: string | null;
  fork_message_id: string | null;
  head_message_id: string | null;
  reason: string;
  created_at: number | string;
  active_branch_id?: string | null;
};

/** Client shape of a chat branch. */
export type ChatBranchSummary = {
  id: string;
  chatId: string;
  parentBranchId?: string;
  forkMessageId?: string;
  headMessageId?: string;
  reason: string;
  createdAt: number;
};

/** Input accepted by `createChatBranch`. */
export type CreateChatBranchInput = {
  chatId: string;
  id: string;
  parentBranchId?: string | null;
  forkMessageId?: string | null;
  reason?: string;
  createdAt?: number | string | null;
};

/** Options of `loadPlugins`. */
export type LoadPluginsOptions = { pluginId?: string | null };

/** Module row accepted by the module value writer. */
export type ModuleValueUpsert = { id: string; data: unknown };

/** Module record queued for the module tables. */
export type ModuleEntry = { id: string; position: number; data: unknown };

/** `system.module_records` listing row. */
export type ModuleRecordRow = { module_id: string; position: number | string };

/** Progress event posted by `sync`; vendors fill in the fields they report. */
export type SyncProgressEvent = {
  stage: string;
  message: string;
  percentage?: number;
  /** Legacy alias of {@link percentage} still emitted by the Oracle vendor. */
  percent?: number;
  count?: number;
  current?: number;
  total?: number;
  /** Table being written by the bulk-insert helper. */
  table?: string;
};

export type SyncProgressCallback = (event: SyncProgressEvent) => void;

/** Options of `sync`; the legacy form passes the progress callback directly. */
export type SyncOptions = Record<string, unknown>;

/**
 * Transaction context reused when the storage-sync importer already owns the
 * transaction. `client` is the vendor connection type, so this stays generic.
 */
export type ExternalSyncTransaction<TClient = unknown> = {
  client: TClient;
  currentRevision: number;
  nextRevision: number;
  revisionId: number;
  storageSyncImport?: boolean;
};

/** Context handed to the finalize callback of a storage-sync replacement. */
export type StorageSyncFinalizeContext = {
  currentRevision: number;
  nextRevision: number;
  revisionId: number;
  previousRevisionId: number | null;
  databaseInitialized: boolean;
};

/** Legacy `chat.attributes.branchState` payload plus the current branch count. */
export type LegacyBranchStateRow = {
  branch_count: number | string | null;
  branch_state: unknown;
};

/** `system.storage_meta` singleton row. */
export type StorageMetaRow = {
  revision: number | string;
  initialized: boolean | null;
};

/** Aggregated row counts of `getStorageSyncSummary`. */
export type StorageSyncSummaryRow = {
  revision: number | string | null;
  initialized: boolean | null;
  settings_count: number | string;
  characters_count: number | string;
  chats_count: number | string;
  messages_count: number | string;
};

/** Key-only row of `system.asset_catalog`. */
export type AssetCatalogKeyRow = { asset_key: string };

/** Full listing row of `system.asset_catalog`. */
export type AssetCatalogRow = {
  asset_key: string;
  size_bytes: number | string | null;
  etag: string | null;
  updated_at: string | Date | null;
};

/** Entry returned by `listAssetCatalogEntries`. */
export type AssetCatalogEntryRow = {
  key: string;
  size: number | null;
  etag: string | null;
  updatedAt: number | null;
};

/**
 * Cold mirror of a character row: the archive id replaces the character owner.
 */
export type ColdCharacterRowOf<TRow> = Omit<TRow, "character_id"> & {
  archive_id: string;
};

/** Cold mirror of a chat row: archive id and chat position replace the owner. */
export type ColdChatRowOf<TRow> = Omit<TRow, "chat_id"> & {
  archive_id: string;
  chat_position: number;
};

/** Cold mirror of a message row: archive, chat and message positions. */
export type ColdMessageRowOf<TRow> = Omit<TRow, "chat_id" | "message_id"> & {
  archive_id: string;
  chat_position: number;
  message_position: number;
};

/** Row of `cold.field_presence`: which entity fields survived the archive. */
export type ColdFieldPresenceRow = {
  archive_id: string;
  entity_type: "character" | "chat" | "message";
  chat_position: number;
  entity_position: number;
  field_name: string;
};

/** Row of `cold.chats`. */
export type ColdChatRow = {
  archive_id: string;
  position: number;
  original_chat_id: string | null;
  name: string;
  note: string;
  sd_data: string | null;
  supa_memory_data: string | null;
  last_memory: string | null;
  is_streaming: boolean | null;
  streaming_optimization_mode: string | null;
  bound_persona_id: string | null;
  first_message_index: number | null;
  folder_id: string | null;
  last_message_time: number | string | null;
};

/** Row of `cold.messages`. */
export type ColdMessageRow = {
  archive_id: string;
  chat_position: number;
  position: number;
  original_message_id: string | null;
  role: "user" | "char";
  content_text: string | null;
  content_binary: Buffer | null;
  saying_character_id: string | null;
  sent_time: number | string | null;
  sender_name: string | null;
  other_user: boolean | null;
  disabled_scope: string | null;
  is_comment: boolean | null;
};

/** Every table `loadColdStorage` reads back, with its exact row shape. */
export type ColdTableRows = {
  "cold.archive_attributes": (AttributeRow & { archive_id: string })[];
  "cold.field_presence": ColdFieldPresenceRow[];
  "cold.character_tags": ColdCharacterRowOf<CharacterTagRow>[];
  "cold.character_greetings": ColdCharacterRowOf<CharacterGreetingRow>[];
  "cold.character_biases": ColdCharacterRowOf<CharacterBiasRow>[];
  "cold.character_emotions": ColdCharacterRowOf<CharacterEmotionRow>[];
  "cold.character_modules": ColdCharacterRowOf<CharacterModuleRow>[];
  "cold.group_members": Omit<CharacterGroupMemberRow, "group_id"> &
    {
      archive_id: string;
    }[];
  "cold.chat_folders": ColdCharacterRowOf<CharacterChatFolderRow>[];
  "cold.character_scripts": ColdCharacterRowOf<CharacterScriptRow>[];
  "cold.character_sd_data": ColdCharacterRowOf<CharacterSdRow>[];
  "cold.character_assets": ColdCharacterRowOf<CharacterAssetRow>[];
  "cold.character_lore_entries": ColdCharacterRowOf<CharacterLoreRow>[];
  "cold.chats": ColdChatRow[];
  "cold.chat_attributes": ColdChatRowOf<AttributeRow>[];
  "cold.chat_suggestions": ColdChatRowOf<ChatSuggestionRow>[];
  "cold.chat_modules": ColdChatRowOf<ChatModuleRow>[];
  "cold.chat_script_state": ColdChatRowOf<ChatScriptStateRow>[];
  "cold.chat_bookmarks": ColdChatRowOf<ChatBookmarkRow>[];
  "cold.chat_memory": ColdChatRowOf<ChatMemoryRow>[];
  "cold.chat_lore_entries": ColdChatRowOf<ChatLoreRow>[];
  "cold.messages": ColdMessageRow[];
  "cold.message_attributes": ColdMessageRowOf<AttributeRow>[];
  "cold.message_generation": ColdMessageRowOf<MessageGenerationRow>[];
  "cold.message_prompt_info": ColdMessageRowOf<MessagePromptInfoRow>[];
  "cold.message_prompt_toggles": ColdMessageRowOf<MessagePromptToggleRow>[];
  "cold.message_prompt_items": ColdMessageRowOf<MessagePromptItemRow>[];
};

/** Table name of one cold archive relation. */
export type ColdTableName = keyof ColdTableRows;

/**
 * One `cold.archives` row. The `character_*` columns are generated from the
 * character scalars, so the row stays open beyond the named routing columns.
 */
export type ColdArchiveRow = SqlStorageRow & {
  id: string;
  kind: string;
  revision: number | string;
  updated_at: string | Date;
  owner_character_id: string | null;
  character_kind: string | null;
};

/** Listing row of `cold.archives`. */
export type ColdStorageSummaryRow = {
  key: string;
  kind: string;
  updated_at: string | Date;
};

/**
 * Narrow a raw `SELECT *` result list to the row shape its query produces.
 * The projection is fixed by the statement, so only the declared columns can
 * be read afterwards.
 * 원시 `SELECT *` 결과를 해당 쿼리가 만드는 행 타입으로 좁힙니다.
 */
export function asRows<TRow>(rows: readonly unknown[]): TRow[] {
  return rows as TRow[];
}

/** Narrow an unknown value to a plain array, keeping the element type unknown. */
export function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Narrow an arbitrarily shaped value to a row before reading properties. */
export function isSqlRow(value: unknown): value is SqlStorageRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bot preset payload, decoded from JSONB or the legacy JSON string form. */
export function decodePresetData(data: unknown): SqlStorageRow {
  if (typeof data !== "string") return isSqlRow(data) ? data : {};
  const parsed: unknown = JSON.parse(data);
  return isSqlRow(parsed) ? parsed : {};
}

/** Stored API version strings are restricted to the plugin metadata union. */
export function pluginApiVersion(
  raw: string | null,
): PluginMetadata["version"] {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  if (raw === "2.1") return "2.1";
  if (raw === "3.0") return "3.0";
  if (raw) return raw as PluginMetadata["version"];
  return undefined;
}

/** Legacy module id, preserved verbatim when it is a plain string. */
export function legacyModuleId(data: unknown): string {
  if (isSqlRow(data) && typeof data.id === "string") return data.id;
  return String(isSqlRow(data) ? (data.id ?? "") : "");
}

/** Client shape of a chat branch. */
export function mapBranchRow(row: BranchRow): ChatBranchSummary {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentBranchId: row.parent_branch_id ?? undefined,
    forkMessageId: row.fork_message_id ?? undefined,
    headMessageId: row.head_message_id ?? undefined,
    reason: row.reason,
    createdAt: Number(row.created_at) || 0,
  };
}
