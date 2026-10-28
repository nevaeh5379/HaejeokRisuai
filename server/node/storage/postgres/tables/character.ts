import type { ColumnType, Generated } from "kysely";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// JSONB writes use serialized JSON so JSON `null` stays distinct from SQL NULL.
type JsonColumn = ColumnType<JsonValue, string, string>;
type NullableJsonColumn = ColumnType<
  JsonValue | null,
  string | null | undefined,
  string | null
>;
type NullableBigintColumn = ColumnType<
  string | null,
  string | number | bigint | null | undefined,
  string | number | bigint | null
>;

export interface CharactersTable {
  id: string;
  position: number;
  kind: "character" | "group";
  name: Generated<string>;
  image: string | null;
  first_message: Generated<string>;
  description: string | null;
  notes: string | null;
  creator_notes: string | null;
  system_prompt: string | null;
  post_history_instructions: string | null;
  personality: string | null;
  scenario: string | null;
  example_message: string | null;
  creator: string | null;
  character_version: string | null;
  nickname: string | null;
  view_screen: string | null;
  chat_page: Generated<number>;
  first_message_index: number | null;
  utility_bot: boolean | null;
  is_private: boolean | null;
  realm_id: string | null;
  license: string | null;
  default_variables: string | null;
  additional_text: string | null;
  translator_note: string | null;
  background_html: string | null;
  background_css: string | null;
  creation_time: NullableBigintColumn;
  modification_time: NullableBigintColumn;
  last_interaction_time: NullableBigintColumn;
  trash_time: NullableBigintColumn;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AttributesTable {
  character_id: string;
  key: string;
  value: JsonColumn;
}

export interface TagsTable {
  character_id: string;
  position: number;
  tag: string;
}

export interface GreetingsTable {
  character_id: string;
  greeting_type: "alternate" | "group-only";
  position: number;
  content: string;
}

export interface BiasesTable {
  character_id: string;
  position: number;
  phrase: string;
  bias: number;
}

export interface EmotionsTable {
  character_id: string;
  position: number;
  emotion: string;
  asset: string;
}

export interface ModulesTable {
  character_id: string;
  position: number;
  module_id: string;
}

export interface GroupMembersTable {
  group_id: string;
  position: number;
  character_id: string;
  talk_weight: number | null;
  active: boolean | null;
}

export interface ChatFoldersTable {
  character_id: string;
  position: number;
  folder_id: string;
  name: string | null;
  color: string | null;
  folded: Generated<boolean>;
}

export interface ScriptsTable {
  character_id: string;
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

export interface SdDataTable {
  character_id: string;
  position: number;
  key: string;
  value: string;
}

export interface AssetsTable {
  character_id: string;
  position: number;
  asset_source: "additional" | "character-card";
  asset_type: string | null;
  uri: string | null;
  name: string | null;
  extension: string | null;
  extra_value: string | null;
}

export interface LoreEntriesTable {
  character_id: string;
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

export interface CharacterTables {
  "character.characters": CharactersTable;
  "character.attributes": AttributesTable;
  "character.tags": TagsTable;
  "character.greetings": GreetingsTable;
  "character.biases": BiasesTable;
  "character.emotions": EmotionsTable;
  "character.modules": ModulesTable;
  "character.group_members": GroupMembersTable;
  "character.chat_folders": ChatFoldersTable;
  "character.scripts": ScriptsTable;
  "character.sd_data": SdDataTable;
  "character.assets": AssetsTable;
  "character.lore_entries": LoreEntriesTable;
}
