import type { Selectable, Transaction } from "kysely";
import type { PostgresDatabase } from "../type.ts";
import type { ChatFields } from "../../../../../packages/protocol/domain/chat.ts";
import type { ChatsTable } from "../../../../../packages/protocol/tables/chat.ts";
import {
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

export type RebuiltChat = Partial<ChatFields>;

export function rebuild(
  row: Pick<Selectable<ChatsTable>, "id"> & Partial<Selectable<ChatsTable>>,
  related: ChatRebuildRelations = {},
): RebuiltChat {
  return rebuildChatRows(row, related);
}

function applyChatAttributes(
  target: RebuiltChat,
  rows: readonly AttributeRow[] = [],
): void {
  for (const row of rows) {
    Reflect.set(target, row.key, decodeJsonValue(row.value));
  }
}

function rebuildChatScalars(row: Partial<Selectable<ChatsTable>>): RebuiltChat {
  return {
    id: row.id,
    characterId: row.character_id,
    position: row.position,
    name: row.name ?? undefined,
    note: row.note ?? undefined,
    sdData: row.sd_data ?? undefined,
    supaMemoryData: row.supa_memory_data ?? undefined,
    lastMemory: row.last_memory ?? undefined,
    isStreaming: row.is_streaming ?? undefined,
    activeStreamingDisplayOptimizationMode:
      row.streaming_optimization_mode ?? undefined,
    bindedPersona: row.bound_persona_id ?? undefined,
    fmIndex: row.first_message_index ?? undefined,
    folderId: row.folder_id ?? undefined,
    lastDate:
      row.last_message_time == null ? undefined : Number(row.last_message_time),
  };
}

function applyChatBookmarks(
  bookmarks: readonly ChatBookmarkRow[],
): Pick<ChatFields, "bookmarks" | "bookmarkNames"> {
  return {
    bookmarks: bookmarks.map((item) => item.message_id),
    bookmarkNames: Object.fromEntries(
      bookmarks.map((v): [string, string] => [v.message_id, v.name ?? ""]),
    ),
  };
}

function rebuildChatRows(
  row: Pick<Selectable<ChatsTable>, "id"> & Partial<Selectable<ChatsTable>>,
  relations: ChatRebuildRelations,
): RebuiltChat {
  const chat = rebuildChatScalars(row);

  //TODO 리팩토링 필요
  if (relations.bookmarks != undefined && relations.bookmarks.length !== 0) {
    ({ bookmarks: chat.bookmarks, bookmarkNames: chat.bookmarkNames } =
      applyChatBookmarks(relations.bookmarks));
  }

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
    const state: NonNullable<ChatFields["scriptstate"]> = {};
    for (const item of scriptState) {
      state[item.key] =
        item.value_type === "text"
          ? item.text_value
          : item.value_type === "number"
            ? Number(item.number_value)
            : item.boolean_value;
    }
    chat.scriptstate = state;
  }
  for (const item of relations.memory ?? []) {
    Reflect.set(
      chat,
      item.memory_type === "hypa-v2" ? "hypaV2Data" : "hypaV3Data",
      decodeJsonValue(item.payload),
    );
  }

  applyChatAttributes(chat, relations.attributes);

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
export function planChatRead(
  keys: readonly (keyof ChatFields)[],
): ChatReadPlan {
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
