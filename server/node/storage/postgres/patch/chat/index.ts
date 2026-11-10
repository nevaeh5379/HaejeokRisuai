import type { Updateable } from "kysely";
import type { ChatUpdate } from "../../../../../../packages/protocol/domain/chat.ts";
import type { ChatsTable } from "../../../../../../packages/protocol/tables/chat.ts";
import { CHAT_FIELD_STORAGE } from "../../relationalCodec.ts";
import { Attributes } from "./attributes.ts";
import { Relation } from "./relation.ts";

export function getColumn(patch: ChatUpdate): Updateable<ChatsTable> {
  const columns: Updateable<ChatsTable> = {};
  const keys = (Object.keys(patch) as (keyof ChatUpdate)[]).filter((v) =>
    typeof patch[v] === "string" ? !patch[v].includes("\0") : patch[v] !== undefined,
  );
  for (const key of keys) {
    const storage = CHAT_FIELD_STORAGE[key];
    if (storage.kind !== "column") continue;
    Object.assign(columns, { [storage.column]: patch[key] });
  }
  return columns;
}

/** PostgreSQL chat write inputs derived from the table declarations. */
export function chatPatch(id: string, patch: ChatUpdate) {
  const columns = getColumn(patch);
  const relations = Relation.fromPatch(id, patch);
  const { attributes, clearedAttributeKeys } = Attributes.fromPatch(id, patch);
  return { columns, relations, attributes, clearedAttributeKeys };
}
