import type { Selectable, Transaction } from "kysely";
import type { PostgresDatabase } from "../type.ts";
import type { ChatFields } from "../../../../../packages/protocol/domain/chat.ts";
import type { ChatsTable } from "../../../../../packages/protocol/tables/chat.ts";
import {
  CHAT_SCALARS,
  CHAT_FIELD_STORAGE,
  rebuildLore,
  type ChatRelationKey,
} from "../relationalCodec.ts";
import { decodeJsonValue } from "../jsonCodec.ts";
import type {
  AttributeRow,
  ChatBookmarkRow,
  ChatLoreRow,
  ChatMemoryRow,
  ChatModuleRow,
  ChatScriptStateRow,
  ChatSuggestionRow,
} from "../../relationalRows.ts";

type ChatRebuildRelations = Record<string, unknown> & {
  attributes?: readonly AttributeRow[];
  bookmarks?: readonly ChatBookmarkRow[];
  lore?: readonly ChatLoreRow[];
  memory?: readonly ChatMemoryRow[];
  messages?: Record<string, unknown>[];
  modules?: readonly ChatModuleRow[];
  scriptState?: readonly ChatScriptStateRow[];
  suggestions?: readonly ChatSuggestionRow[];
};

type ChatRebuildOptions = { shallow?: boolean };

export type RebuiltChat = Partial<ChatFields> &
  Record<string, unknown> & {
    id: string;
    name: string;
    note: string;
    message: Record<string, unknown>[];
  };

// export function rebuild(
//   row: object,
//   related?: Record<string, unknown>,
//   options?: ChatRebuildOptions,
// ): RebuiltChat;
// export function rebuild(
//   row: object,
//   related: readonly unknown[],
//   options?: readonly unknown[],
//   ..._legacyRelations: unknown[]
// ): RebuiltChat;
export function rebuild(
  row: Partial<Selectable<ChatsTable>>,
  related: Record<string, unknown> | readonly unknown[] = {},
  options: ChatRebuildOptions | readonly unknown[] = {},
): RebuiltChat {
  const relations: ChatRebuildRelations = isChatRebuildRelations(related)
    ? related
    : {};
  const rebuildOptions: ChatRebuildOptions = isChatRebuildOptions(options)
    ? options
    : {};
  return rebuildChatRows(row, relations, rebuildOptions);
}

const SHALLOW_CHAT_SCALARS = {
  name: "name",
  note: "note",
  folderId: "folder_id",
  fmIndex: "first_message_index",
  bindedPersona: "bound_persona_id",
  lastDate: "last_message_time",
} as const satisfies Partial<Record<keyof ChatFields, keyof ChatsTable>>;

function isChatRebuildRelations(
  value: Record<string, unknown> | readonly unknown[],
): value is ChatRebuildRelations {
  return !Array.isArray(value);
}

function isChatRebuildOptions(
  value: ChatRebuildOptions | readonly unknown[],
): value is ChatRebuildOptions {
  return !Array.isArray(value);
}

function applyChatAttributes(
  target: Record<string, unknown>,
  rows: readonly AttributeRow[] = [],
): void {
  for (const row of rows) target[row.key] = decodeJsonValue(row.value);
}

function readChatRowValue(row: object, key: string): unknown {
  const value: unknown = Reflect.get(row, key);
  return value;
}

function rebuildChatRows(
  row: object,
  relations: ChatRebuildRelations,
  rebuildOptions: ChatRebuildOptions,
): RebuiltChat {
  const id = readChatRowValue(row, "id");
  if (typeof id !== "string") {
    throw new TypeError("Chat row must include a string id");
  }
  const chat: RebuiltChat = { id, name: "", note: "", message: [] };
  const chatValues: Record<string, unknown> = chat;
  const scalarMap = rebuildOptions.shallow
    ? SHALLOW_CHAT_SCALARS
    : CHAT_SCALARS;
  for (const [property, column] of Object.entries(scalarMap) as [
    keyof ChatFields,
    keyof ChatsTable,
  ][]) {
    const value = readChatRowValue(row, column);
    if (value !== null && value !== undefined) {
      chatValues[property] =
        column === "last_message_time" ? Number(value) : value;
    }
  }

  const bookmarks = relations.bookmarks ?? [];
  if (bookmarks.length) {
    chat.bookmarks = bookmarks.map((item) => item.message_id);
    const bookmarkNames: Record<string, string> = {};
    for (const item of bookmarks) {
      if (item.name !== null) bookmarkNames[item.message_id] = item.name;
    }
    chat.bookmarkNames = bookmarkNames;
  }

  if (!rebuildOptions.shallow) {
    chat.localLore = (relations.lore ?? []).map(rebuildLore);
    const suggestions = relations.suggestions ?? [];
    if (suggestions.length) {
      chat.suggestMessages = suggestions.map((item) => item.content);
    }
    const modules = relations.modules ?? [];
    if (modules.length) {
      chat.modules = modules.map((item) => item.module_id);
    }
    const scriptState = relations.scriptState ?? [];
    if (scriptState.length) {
      const state: Record<string, unknown> = {};
      for (const item of scriptState) {
        state[item.key] =
          item.value_type === "text"
            ? item.text_value
            : item.value_type === "number"
              ? Number(item.number_value)
              : item.boolean_value;
      }
      chatValues.scriptstate = state;
    }
    for (const item of relations.memory ?? []) {
      chatValues[
        item.memory_type === "hypa-v2" ? "hypaV2Data" : "hypaV3Data"
      ] = decodeJsonValue(item.payload);
    }

    applyChatAttributes(chatValues, relations.attributes);
  }

  chat.message = relations.messages ?? [];
  return chat;
}

/** Projections one chat read needs, one entry per storage location. */
export type ChatReadPlan = {
  columns: (keyof ChatsTable)[];
  attributeKeys: (keyof ChatFields)[];
  relationKeys: ChatRelationKey[];
  needsActiveBranch: boolean;
};

/**
 * Groups the requested chat fields by where `CHAT_FIELD_STORAGE` says they live.
 * `id` is always selected so the row can be identified. A storage kind this
 * switch does not handle fails to compile instead of silently reading nothing.
 */
export function planChatRead(keys: readonly (keyof ChatFields)[]): ChatReadPlan {
  const columns = new Set<keyof ChatsTable>(["id"]);
  const attributeKeys: (keyof ChatFields)[] = [];
  const relationKeys = new Set<ChatRelationKey>();
  let needsActiveBranch = false;

  for (const key of keys) {
    const storage = CHAT_FIELD_STORAGE[key];
    switch (storage.kind) {
      case "column":
        columns.add(storage.column);
        break;
      case "relation":
        relationKeys.add(storage.relation);
        break;
      case "branch":
        needsActiveBranch = true;
        break;
      case "attribute":
        attributeKeys.push(key);
        break;
      default: {
        const unhandled: never = storage;
        throw new Error(`Unhandled chat storage kind: ${unhandled}`);
      }
    }
  }

  return {
    columns: [...columns],
    attributeKeys,
    relationKeys: [...relationKeys],
    needsActiveBranch,
  };
}

export const position = {
  /**
   * @param id character id.
   * @return value max position. or -1 if character has no any chats.
   */
  max: async (
    id: string,
    trx: Transaction<PostgresDatabase>,
  ): Promise<number> => {
    return (
      (
        await trx
          .selectFrom("chat.chats")
          .select((eb) => eb.fn.max("position").as("maxPosition"))
          .where("chat.chats.character_id", "=", id)
          .executeTakeFirstOrThrow()
      ).maxPosition ?? -1
    );
  },
};
