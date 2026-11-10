import type { Insertable } from "kysely";
import type { ChatUpdate } from "../../../../../../packages/protocol/domain/chat.ts";
import type { ChatTables } from "../../../../../../packages/protocol/tables/chat.ts";
import { splitLore } from "../../relationalCodec.ts";
import { encodeJsonValue } from "../../jsonCodec.ts";

//TODO 중복 선언?
export const CHAT_RELATIONS = {
  localLore: { table: "chat.lore_entries" },
  suggestMessages: { table: "chat.suggestions" },
  modules: { table: "chat.modules" },
  scriptstate: { table: "chat.script_state" },
  bookmarks: { table: "chat.bookmarks" },
  hypaV2Data: { table: "chat.memory", memoryType: "hypa-v2" },
  hypaV3Data: { table: "chat.memory", memoryType: "hypa-v3" },
} as const;

export type Key = keyof typeof CHAT_RELATIONS;
export type Rows = {
  [K in Key]?: Insertable<ChatTables[(typeof CHAT_RELATIONS)[K]["table"]]>[];
};
type RelationMappers = {
  [K in Key]: (
    id: string,
    value: NonNullable<ChatUpdate[K]>,
    patch: ChatUpdate,
  ) => NonNullable<Rows[K]>;
};

const relationMappers: RelationMappers = {
  localLore: (id, value) => {
    const rows: NonNullable<Rows["localLore"]> = splitLore(
      { chat_id: id },
      value,
    );
    return rows.map((row) => {
      let cachePayload: string | null = null;
      if (row.cache_payload != null) {
        cachePayload = JSON.stringify(row.cache_payload);
      }
      return { ...row, cache_payload: cachePayload };
    });
  },
  suggestMessages: (id, values) =>
    values.map((content, position) => ({ chat_id: id, position, content })),
  modules: (id, values) =>
    values.map((module_id, position) => ({ chat_id: id, position, module_id })),
  bookmarks: (id, values, patch) =>
    values.map((message_id, position) => ({
      chat_id: id,
      position,
      message_id,
      name: patch.bookmarkNames?.[message_id] ?? null,
    })),
  scriptstate: (id, values) =>
    Object.entries(values).map(([key, value]) => {
      const row: Insertable<ChatTables["chat.script_state"]> = {
        chat_id: id,
        key,
        value_type: "text",
        text_value: null,
        number_value: null,
        boolean_value: null,
      };

      switch (typeof value) {
        case "string":
          row.value_type = "text";
          row.text_value = value;
          break;
        case "number":
          row.value_type = "number";
          row.number_value = value;
          break;
        case "boolean":
          row.value_type = "boolean";
          row.boolean_value = value;
          break;

        default:
          throw new Error(`type is ${typeof value}`);
      }
      return row;
    }),
  hypaV2Data: (id, value) => [
    {
      chat_id: id,
      memory_type: "hypa-v2",
      payload: JSON.stringify(encodeJsonValue(value)),
    },
  ],
  hypaV3Data: (id, value) => [
    {
      chat_id: id,
      memory_type: "hypa-v3",
      payload: JSON.stringify(encodeJsonValue(value)),
    },
  ],
};

function getRows<K extends Key>(
  id: string,
  key: K,
  patch: ChatUpdate,
): Rows[K] {
  const value = patch[key];
  return relationMappers[key](id, value as NonNullable<ChatUpdate[K]>, patch);
}

export const Relation = {
  fromPatch(id: string, patch: ChatUpdate): Rows {
    const relations: Rows = {};
    for (const key of Object.keys(patch) as Key[]) {
      if (!Object.hasOwn(relationMappers, key)) continue;
      if (patch[key] === undefined) continue;
      Object.assign(relations, { [key]: getRows(id, key, patch) });
    }
    return relations;
  },
};
