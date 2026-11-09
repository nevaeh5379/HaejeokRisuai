import type { Transaction } from "kysely";
import type { PostgresDatabase } from "../type.ts";
import type { ChatFields } from "../../../../../packages/protocol/domain/chat.ts";
import type { ChatsTable } from "../../../../../packages/protocol/tables/chat.ts";
import {
  CHAT_FIELD_STORAGE,
  type ChatRelationKey,
} from "../relationalCodec.ts";

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
