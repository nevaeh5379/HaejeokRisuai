import type { Buffer } from "node:buffer";
import type { ColumnType, Generated } from "kysely";
import type { JsonValue } from "./character.ts";

type BigintInput = string | number | bigint;
type BigintColumn = ColumnType<string, BigintInput, BigintInput>;
type NullableBigintColumn = ColumnType<
  string | null,
  BigintInput | null | undefined,
  BigintInput | null
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

export interface ChatsTable {
  id: string;
  character_id: string;
  position: number;
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
  updated_at: TimestampColumn;
}

export interface AttributesTable {
  chat_id: string;
  key: string;
  value: JsonColumn;
}

export interface SuggestionsTable {
  chat_id: string;
  position: number;
  content: string;
}

export interface ModulesTable {
  chat_id: string;
  position: number;
  module_id: string;
}

export interface ScriptStateTable {
  chat_id: string;
  key: string;
  value_type: "text" | "number" | "boolean";
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
}

export interface BookmarksTable {
  chat_id: string;
  position: number;
  message_id: string;
  name: string | null;
}

export interface MemoryTable {
  chat_id: string;
  memory_type: string;
  payload: JsonColumn;
}

export interface LoreEntriesTable {
  chat_id: string;
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
  chat_id: string;
  id: string;
  position: number;
  role: "user" | "char";
  content_text: string | null;
  content_binary: NullableBinaryColumn;
  saying_character_id: string | null;
  sent_time: NullableBigintColumn;
  sender_name: string | null;
  other_user: boolean | null;
  disabled_scope: "false" | "true" | "allBefore" | null;
  is_comment: boolean | null;
  updated_at: TimestampColumn;
}

export interface BranchesTable {
  chat_id: string;
  id: string;
  parent_branch_id: string | null;
  fork_message_id: string | null;
  head_message_id: string | null;
  reason: "root" | "manual" | "reroll";
  created_at: BigintColumn;
}

export interface ActiveBranchesTable {
  chat_id: string;
  branch_id: string;
}

export interface MessageBranchLinksTable {
  chat_id: string;
  message_id: string;
  parent_message_id: string | null;
  origin_branch_id: string;
}

export interface MessageAttributesTable {
  chat_id: string;
  message_id: string;
  key: string;
  value: JsonColumn;
}

export interface MessageGenerationTable {
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
}

export interface MessagePromptInfoTable {
  chat_id: string;
  message_id: string;
  prompt_name: string | null;
}

export interface MessagePromptTogglesTable {
  chat_id: string;
  message_id: string;
  position: number;
  toggle_key: string;
  toggle_value: string | null;
}

export interface MessagePromptItemsTable {
  chat_id: string;
  message_id: string;
  position: number;
  payload: JsonColumn;
}

export interface ChatTables {
  "chat.chats": ChatsTable;
  "chat.attributes": AttributesTable;
  "chat.suggestions": SuggestionsTable;
  "chat.modules": ModulesTable;
  "chat.script_state": ScriptStateTable;
  "chat.bookmarks": BookmarksTable;
  "chat.memory": MemoryTable;
  "chat.lore_entries": LoreEntriesTable;
  "chat.messages": MessagesTable;
  "chat.branches": BranchesTable;
  "chat.active_branches": ActiveBranchesTable;
  "chat.message_branch_links": MessageBranchLinksTable;
  "chat.message_attributes": MessageAttributesTable;
  "chat.message_generation": MessageGenerationTable;
  "chat.message_prompt_info": MessagePromptInfoTable;
  "chat.message_prompt_toggles": MessagePromptTogglesTable;
  "chat.message_prompt_items": MessagePromptItemsTable;
}
