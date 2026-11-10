import type { CharacterTables } from "../../../../packages/protocol/tables/character.ts";
import type { ChatTables } from "../../../../packages/protocol/tables/chat.ts";
import type { ColdTables } from "../../../../packages/protocol/tables/cold.ts";
import type { SystemTables } from "../../../../packages/protocol/tables/system.ts";

export type PostgresDatabase = CharacterTables &
  SystemTables &
  ChatTables &
  ColdTables;
