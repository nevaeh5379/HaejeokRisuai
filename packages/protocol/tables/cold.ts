import type { Buffer } from "node:buffer";
import type { ColumnType, Generated } from "kysely";
import type { JsonValue } from "./character.ts";

type BigintInput = string | number | bigint;
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
type NullableBinaryColumn = ColumnType<
  Buffer | null,
  Buffer | null | undefined,
  Buffer | null
>;

export interface ArchivesTable {
  id: string;
  kind: "character" | "chat" | "legacy";
  owner_character_id: string | null;
  character_kind: "character" | "group" | null;
  character_name: string | null;
  character_image: string | null;
  character_first_message: string | null;
  character_description: string | null;
  character_notes: string | null;
  character_creator_notes: string | null;
  character_system_prompt: string | null;
  character_post_history_instructions: string | null;
  character_personality: string | null;
  character_scenario: string | null;
  character_example_message: string | null;
  character_creator: string | null;
  character_version: string | null;
  character_nickname: string | null;
  character_view_screen: string | null;
  character_chat_page: number | null;
  character_first_message_index: number | null;
  character_utility_bot: boolean | null;
  character_is_private: boolean | null;
  character_realm_id: string | null;
  character_license: string | null;
  character_default_variables: string | null;
  character_additional_text: string | null;
  character_translator_note: string | null;
  character_background_html: string | null;
  character_background_css: string | null;
  character_creation_time: NullableBigintColumn;
  character_modification_time: NullableBigintColumn;
  character_last_interaction_time: NullableBigintColumn;
  character_trash_time: NullableBigintColumn;
  revision: DefaultBigintColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface ArchiveAttributesTable {
  archive_id: string;
  key: string;
  value: JsonColumn;
}

export interface FieldPresenceTable {
  archive_id: string;
  entity_type: "character" | "chat" | "message";
  chat_position: Generated<number>;
  entity_position: Generated<number>;
  field_name: string;
}

export interface CharacterTagsTable {
  archive_id: string;
  position: number;
  tag: string;
}

export interface CharacterGreetingsTable {
  archive_id: string;
  greeting_type: "alternate" | "group-only";
  position: number;
  content: string;
}

export interface CharacterBiasesTable {
  archive_id: string;
  position: number;
  phrase: string;
  bias: number;
}

export interface CharacterEmotionsTable {
  archive_id: string;
  position: number;
  emotion: string;
  asset: string;
}

export interface CharacterModulesTable {
  archive_id: string;
  position: number;
  module_id: string;
}

export interface GroupMembersTable {
  archive_id: string;
  position: number;
  character_id: string;
  talk_weight: number | null;
  active: boolean | null;
}

export interface ChatFoldersTable {
  archive_id: string;
  position: number;
  folder_id: string;
  name: string | null;
  color: string | null;
  folded: Generated<boolean>;
}

export interface CharacterScriptsTable {
  archive_id: string;
  script_kind: "custom" | "trigger";
  position: number;
  comment: string | null;
  input_text: string | null;
  output_text: string | null;
  script_type: string | null;
  flag: string | null;
  able_flag: boolean | null;
  trigger_payload: NullableJsonColumn;
}

export interface CharacterSdDataTable {
  archive_id: string;
  position: number;
  key: string;
  value: string;
}

export interface CharacterAssetsTable {
  archive_id: string;
  position: number;
  asset_source: "additional" | "character-card";
  asset_type: string | null;
  uri: string | null;
  name: string | null;
  extension: string | null;
  extra_value: string | null;
}

export interface CharacterLoreEntriesTable {
  archive_id: string;
  position: number;
  lore_id: string | null;
  primary_key: Generated<string>;
  secondary_key: Generated<string>;
  insert_order: Generated<number>;
  comment: Generated<string>;
  content: Generated<string>;
  mode: Generated<string>;
  always_active: Generated<boolean>;
  selective: Generated<boolean>;
  case_sensitive: boolean | null;
  activation_percent: number | null;
  use_regex: boolean | null;
  book_version: number | null;
  folder: string | null;
  cache_payload: NullableJsonColumn;
}

export interface ChatsTable {
  archive_id: string;
  position: number;
  original_chat_id: string | null;
  name: Generated<string>;
  note: Generated<string>;
  sd_data: string | null;
  supa_memory_data: string | null;
  last_memory: string | null;
  is_streaming: boolean | null;
  streaming_optimization_mode: string | null;
  bound_persona_id: string | null;
  first_message_index: number | null;
  folder_id: string | null;
  last_message_time: NullableBigintColumn;
}

export interface ChatAttributesTable {
  archive_id: string;
  chat_position: number;
  key: string;
  value: JsonColumn;
}

export interface ChatSuggestionsTable {
  archive_id: string;
  chat_position: number;
  position: number;
  content: string;
}

export interface ChatModulesTable {
  archive_id: string;
  chat_position: number;
  position: number;
  module_id: string;
}

export interface ChatScriptStateTable {
  archive_id: string;
  chat_position: number;
  key: string;
  value_type: "text" | "number" | "boolean";
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
}

export interface ChatBookmarksTable {
  archive_id: string;
  chat_position: number;
  position: number;
  message_id: string;
  name: string | null;
}

export interface ChatMemoryTable {
  archive_id: string;
  chat_position: number;
  memory_type: string;
  payload: JsonColumn;
}

export interface ChatLoreEntriesTable {
  archive_id: string;
  chat_position: number;
  position: number;
  lore_id: string | null;
  primary_key: Generated<string>;
  secondary_key: Generated<string>;
  insert_order: Generated<number>;
  comment: Generated<string>;
  content: Generated<string>;
  mode: Generated<string>;
  always_active: Generated<boolean>;
  selective: Generated<boolean>;
  case_sensitive: boolean | null;
  activation_percent: number | null;
  use_regex: boolean | null;
  book_version: number | null;
  folder: string | null;
  cache_payload: NullableJsonColumn;
}

export interface MessagesTable {
  archive_id: string;
  chat_position: number;
  position: number;
  original_message_id: string | null;
  role: "user" | "char";
  content_text: string | null;
  content_binary: NullableBinaryColumn;
  saying_character_id: string | null;
  sent_time: NullableBigintColumn;
  sender_name: string | null;
  other_user: boolean | null;
  disabled_scope: "false" | "true" | "allBefore" | null;
  is_comment: boolean | null;
}

export interface MessageAttributesTable {
  archive_id: string;
  chat_position: number;
  message_position: number;
  key: string;
  value: JsonColumn;
}

export interface MessageGenerationTable {
  archive_id: string;
  chat_position: number;
  message_position: number;
  model: string | null;
  generation_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  max_context: number | null;
  stage1_time: number | null;
  stage2_time: number | null;
  stage3_time: number | null;
  stage4_time: number | null;
}

export interface MessagePromptInfoTable {
  archive_id: string;
  chat_position: number;
  message_position: number;
  prompt_name: string | null;
}

export interface MessagePromptTogglesTable {
  archive_id: string;
  chat_position: number;
  message_position: number;
  position: number;
  toggle_key: string;
  toggle_value: string | null;
}

export interface MessagePromptItemsTable {
  archive_id: string;
  chat_position: number;
  message_position: number;
  position: number;
  payload: JsonColumn;
}

export interface LegacyImportsTable {
  id: string;
  imported_at: TimestampColumn;
}

export interface ColdTables {
  "cold.archives": ArchivesTable;
  "cold.archive_attributes": ArchiveAttributesTable;
  "cold.field_presence": FieldPresenceTable;
  "cold.character_tags": CharacterTagsTable;
  "cold.character_greetings": CharacterGreetingsTable;
  "cold.character_biases": CharacterBiasesTable;
  "cold.character_emotions": CharacterEmotionsTable;
  "cold.character_modules": CharacterModulesTable;
  "cold.group_members": GroupMembersTable;
  "cold.chat_folders": ChatFoldersTable;
  "cold.character_scripts": CharacterScriptsTable;
  "cold.character_sd_data": CharacterSdDataTable;
  "cold.character_assets": CharacterAssetsTable;
  "cold.character_lore_entries": CharacterLoreEntriesTable;
  "cold.chats": ChatsTable;
  "cold.chat_attributes": ChatAttributesTable;
  "cold.chat_suggestions": ChatSuggestionsTable;
  "cold.chat_modules": ChatModulesTable;
  "cold.chat_script_state": ChatScriptStateTable;
  "cold.chat_bookmarks": ChatBookmarksTable;
  "cold.chat_memory": ChatMemoryTable;
  "cold.chat_lore_entries": ChatLoreEntriesTable;
  "cold.messages": MessagesTable;
  "cold.message_attributes": MessageAttributesTable;
  "cold.message_generation": MessageGenerationTable;
  "cold.message_prompt_info": MessagePromptInfoTable;
  "cold.message_prompt_toggles": MessagePromptTogglesTable;
  "cold.message_prompt_items": MessagePromptItemsTable;
  "cold.legacy_imports": LegacyImportsTable;
}
