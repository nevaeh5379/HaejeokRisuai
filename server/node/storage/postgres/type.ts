import { CharacterTables } from "../../../../packages/protocol/tables/character";
import { ChatTables } from "../../../../packages/protocol/tables/chat";
import { ColdTables } from "../../../../packages/protocol/tables/cold";
import { SystemTables } from "../../../../packages/protocol/tables/system";

export type PostgresDatabase = CharacterTables &
  SystemTables &
  ChatTables &
  ColdTables;