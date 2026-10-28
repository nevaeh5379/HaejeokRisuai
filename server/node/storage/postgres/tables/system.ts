import type { ColumnType, Generated } from "kysely";
import type { JsonValue } from "./character.ts";

type BigintInput = string | number | bigint;
type BigintColumn = ColumnType<string, BigintInput, BigintInput>;
type NullableBigintColumn = ColumnType<
  string | null,
  BigintInput | null | undefined,
  BigintInput | null
>;
type DefaultBigintColumn = ColumnType<
  string,
  BigintInput | undefined,
  BigintInput
>;
type BigserialColumn = ColumnType<string, BigintInput | undefined, BigintInput>;
type TimestampColumn = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
// JSONB writes use serialized JSON so JSON `null` stays distinct from SQL NULL.
type JsonColumn = ColumnType<JsonValue, string, string>;
type NullableJsonColumn = ColumnType<
  JsonValue | null,
  string | null | undefined,
  string | null
>;

export interface StorageMetaTable {
  singleton: Generated<true>;
  schema_version: Generated<number>;
  schema_layout: Generated<string>;
  revision: DefaultBigintColumn;
  initialized: Generated<boolean>;
  updated_at: TimestampColumn;
}

export interface AssetCatalogStateTable {
  singleton: Generated<true>;
  initialized: Generated<boolean>;
  source_id: string | null;
  synced_at: Date | null;
}

export interface AssetCatalogTable {
  asset_key: string;
  size_bytes: NullableBigintColumn;
  etag: string | null;
  updated_at: TimestampColumn;
}

export interface RevisionsTable {
  id: BigserialColumn;
  storage_revision: NullableBigintColumn;
  database_initialized: boolean | null;
  scope: "database" | "cold-storage" | "restore";
  action: string;
  restored_from_revision: NullableBigintColumn;
  created_at: TimestampColumn;
}

export interface AuditLogTable {
  sequence: BigserialColumn;
  revision_id: BigintColumn;
  table_name: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  before_row: NullableJsonColumn;
  after_row: NullableJsonColumn;
  recorded_at: TimestampColumn;
}

export interface SettingsTable {
  key: string;
  text_val: string | null;
  num_val: number | null;
  bool_val: boolean | null;
  updated_at: TimestampColumn;
}

export interface SettingValuesTable {
  setting_key: string;
  node_id: number;
  parent_node_id: number | null;
  member_key: string | null;
  encoded_member_key: string | null;
  position: number | null;
  value_type:
    | "null"
    | "text"
    | "encoded-text"
    | "number"
    | "boolean"
    | "array"
    | "object";
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
}

export interface ModuleRecordsTable {
  module_id: string;
  position: number;
  updated_at: TimestampColumn;
}

export interface ModuleValuesTable {
  module_id: string;
  node_id: number;
  parent_node_id: number | null;
  member_key: string | null;
  encoded_member_key: string | null;
  position: number | null;
  value_type:
    | "null"
    | "text"
    | "encoded-text"
    | "number"
    | "boolean"
    | "array"
    | "object";
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
}

export interface PluginRecordsTable {
  plugin_id: string;
  position: number;
  name: string;
  display_name: string | null;
  api_version: string | null;
  plugin_version: string | null;
  update_url: string | null;
  enabled: Generated<boolean>;
  updated_at: TimestampColumn;
}

export interface PluginScriptsTable {
  plugin_id: string;
  script: string;
  updated_at: TimestampColumn;
}

export interface PluginValuesTable {
  plugin_id: string;
  node_id: number;
  parent_node_id: number | null;
  member_key: string | null;
  encoded_member_key: string | null;
  position: number | null;
  value_type:
    | "null"
    | "text"
    | "encoded-text"
    | "number"
    | "boolean"
    | "array"
    | "object";
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
}

export interface PluginCustomStorageTable {
  key: string;
  value: JsonColumn;
  updated_at: TimestampColumn;
}

export interface BotPresetsTable {
  preset_id: string;
  position: number;
  name: Generated<string>;
  image: Generated<string>;
  api_type: Generated<string>;
  ai_model: Generated<string>;
  data: JsonColumn;
  content_hash: string;
  updated_at: TimestampColumn;
}

export interface PersonasTable {
  setting_key: Generated<"personas">;
  position: number;
  persona_id: string | null;
  name: string | null;
  prompt: string | null;
  icon: string | null;
  large_portrait: boolean | null;
  note: string | null;
  embedded_module_id: string | null;
}

export interface ModulesTable {
  setting_key: Generated<"modules">;
  position: number;
  module_id: string | null;
  name: string | null;
  description: string | null;
  cjs: string | null;
  low_level_access: boolean | null;
  hide_icon: boolean | null;
  background_embedding: string | null;
  namespace: string | null;
  custom_toggle: string | null;
  mcp_url: string | null;
  icon: string | null;
}

export interface PluginsTable {
  setting_key: "plugins" | "pluginV2";
  position: number;
  name: string | null;
  display_name: string | null;
  script: string | null;
  api_version: string | null;
  plugin_version: string | null;
  update_url: string | null;
  enabled: boolean | null;
}

export interface GlobalLorebooksTable {
  setting_key: Generated<"loreBook">;
  position: number;
  name: string | null;
}

export interface GlobalLoreEntriesTable {
  setting_key: Generated<"loreBook">;
  book_position: number;
  position: number;
  lore_id: string | null;
  primary_key: string | null;
  secondary_key: string | null;
  insert_order: number | null;
  comment: string | null;
  content: string | null;
  mode: string | null;
  always_active: boolean | null;
  selective: boolean | null;
  case_sensitive: boolean | null;
  activation_percent: number | null;
  use_regex: boolean | null;
  book_version: number | null;
  folder: string | null;
  cache_key: string | null;
}

export interface GlobalLoreCacheItemsTable {
  setting_key: Generated<"loreBook">;
  book_position: number;
  lore_position: number;
  position: number;
  value: string;
}

export interface TranslatorPresetsTable {
  setting_key: Generated<"translatorPresets">;
  position: number;
  name: string | null;
  prompt: string | null;
  max_response: number | null;
}

export interface HotkeysTable {
  setting_key: Generated<"hotkeys">;
  position: number;
  key: string | null;
  control: boolean | null;
  shift: boolean | null;
  alt: boolean | null;
  action: string | null;
}

export interface CustomModelsTable {
  setting_key: Generated<"customModels">;
  position: number;
  id: string | null;
  internal_id: string | null;
  url: string | null;
  format: number | null;
  tokenizer: number | null;
  api_key: string | null;
  name: string | null;
  params: string | null;
}

export interface CustomModelFlagsTable {
  setting_key: Generated<"customModels">;
  model_position: number;
  position: number;
  flag: number;
}

export interface LoadoutsTable {
  setting_key: Generated<"loadouts">;
  position: number;
  id: string | null;
  name: string | null;
  last_used: NullableBigintColumn;
  favorite: boolean | null;
  preset_name: string | null;
  persona_id: string | null;
  icons_present: Generated<boolean>;
}

export interface LoadoutCharacterRefsTable {
  setting_key: Generated<"loadouts">;
  loadout_position: number;
  position: number;
  character_id: string;
}

export interface LoadoutModuleRefsTable {
  setting_key: Generated<"loadouts">;
  loadout_position: number;
  position: number;
  module_id: string;
}

export interface LoadoutVariablesTable {
  setting_key: Generated<"loadouts">;
  loadout_position: number;
  key: string;
  value: string;
}

export interface LoadoutIconsTable {
  setting_key: Generated<"loadouts">;
  loadout_position: number;
  position: number;
  asset_id: string;
}

export interface CustomSidebarItemsTable {
  setting_key: Generated<"customSidebarItems">;
  position: number;
  id: string | null;
  item_type: string | null;
  subtype: string | null;
  label: string | null;
}

export interface OrderedTextSettingsTable {
  setting_key:
    | "formatingOrder"
    | "localStopStrings"
    | "enabledModules"
    | "banCharacterset"
    | "modelTools";
  position: number;
  value: string;
}

export interface OrderedNumberSettingsTable {
  setting_key: "customFlags";
  position: number;
  value: number;
}

export interface StringMapSettingsTable {
  setting_key: "globalChatVariables" | "OaiCompAPIKeys" | "seperateModels";
  key: string;
  value: string;
}

export interface BiasEntriesTable {
  setting_key: Generated<"bias">;
  position: number;
  phrase: string;
  bias: number;
}

export interface AdditionalParametersTable {
  setting_key: Generated<"additionalParams">;
  position: number;
  key: string;
  value: string;
}

export interface FallbackModelsTable {
  setting_key: Generated<"fallbackModels">;
  category: string;
  position: number;
  model: string;
}

export interface OpenrouterProviderRulesTable {
  setting_key: Generated<"openrouterProvider">;
  rule_type: "order" | "only" | "ignore";
  position: number;
  provider: string;
}

export interface GlobalAuthorNotesTable {
  id: string;
  name: string;
  content: Generated<string>;
  content_hash: string;
  updated_at: BigintColumn;
}

export interface GlobalAuthorNoteSettingsTable {
  singleton: 1;
  allow_script_write: Generated<boolean>;
  updated_at: BigintColumn;
}

export interface SystemTables {
  "system.storage_meta": StorageMetaTable;
  "system.asset_catalog_state": AssetCatalogStateTable;
  "system.asset_catalog": AssetCatalogTable;
  "system.revisions": RevisionsTable;
  "system.audit_log": AuditLogTable;
  "system.settings": SettingsTable;
  "system.setting_values": SettingValuesTable;
  "system.module_records": ModuleRecordsTable;
  "system.module_values": ModuleValuesTable;
  "system.plugin_records": PluginRecordsTable;
  "system.plugin_scripts": PluginScriptsTable;
  "system.plugin_values": PluginValuesTable;
  "system.plugin_custom_storage": PluginCustomStorageTable;
  "system.bot_presets": BotPresetsTable;
  "system.personas": PersonasTable;
  "system.modules": ModulesTable;
  "system.plugins": PluginsTable;
  "system.global_lorebooks": GlobalLorebooksTable;
  "system.global_lore_entries": GlobalLoreEntriesTable;
  "system.global_lore_cache_items": GlobalLoreCacheItemsTable;
  "system.translator_presets": TranslatorPresetsTable;
  "system.hotkeys": HotkeysTable;
  "system.custom_models": CustomModelsTable;
  "system.custom_model_flags": CustomModelFlagsTable;
  "system.loadouts": LoadoutsTable;
  "system.loadout_character_refs": LoadoutCharacterRefsTable;
  "system.loadout_module_refs": LoadoutModuleRefsTable;
  "system.loadout_variables": LoadoutVariablesTable;
  "system.loadout_icons": LoadoutIconsTable;
  "system.custom_sidebar_items": CustomSidebarItemsTable;
  "system.ordered_text_settings": OrderedTextSettingsTable;
  "system.ordered_number_settings": OrderedNumberSettingsTable;
  "system.string_map_settings": StringMapSettingsTable;
  "system.bias_entries": BiasEntriesTable;
  "system.additional_parameters": AdditionalParametersTable;
  "system.fallback_models": FallbackModelsTable;
  "system.openrouter_provider_rules": OpenrouterProviderRulesTable;
  "system.global_author_notes": GlobalAuthorNotesTable;
  "system.global_author_note_settings": GlobalAuthorNoteSettingsTable;
}
