import { Transaction } from "kysely";
import { PostgresDatabase } from "../type";

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
