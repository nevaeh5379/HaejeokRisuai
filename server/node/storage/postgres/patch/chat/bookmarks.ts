import type { Insertable, Selectable } from "kysely";
import type { ChatUpdate } from "../../../../../../packages/protocol/domain/chat.ts";
import type { ChatTables } from "../../../../../../packages/protocol/tables/chat.ts";
import { containsNul } from "../../relationalCodec.ts";
import { decodeJsonValue, encodeJsonValue } from "../../jsonCodec.ts";

type BookmarkRow = Pick<
  Selectable<ChatTables["chat.bookmarks"]>,
  "message_id" | "name"
>;
type AttributeRow = Pick<
  Selectable<ChatTables["chat.attributes"]>,
  "key" | "value"
>;

export const Bookmarks = {
  /** Converts supplied bookmark fields while preserving the omitted field. */
  fromPatch(
    id: string,
    patch: ChatUpdate,
    currentRows: BookmarkRow[],
    currentAttributes: AttributeRow[],
  ) {
    const current: Pick<ChatUpdate, "bookmarks" | "bookmarkNames"> = {
      bookmarks: currentRows.map((row) => row.message_id),
      bookmarkNames: Object.fromEntries(
        currentRows.map((row) => [row.message_id, row.name ?? ""]),
      ),
    };
    for (const row of currentAttributes) {
      Reflect.set(current, row.key, decodeJsonValue(row.value) ?? undefined);
    }
    const bookmarks = patch.bookmarks ?? current.bookmarks;
    const names = patch.bookmarkNames ?? current.bookmarkNames;

    let rows: Insertable<ChatTables["chat.bookmarks"]>[] = [];
    if (bookmarks?.length && !containsNul(bookmarks)) {
      rows = bookmarks.map((message_id, position) => {
        let name = names?.[message_id] ?? null;
        if (containsNul(name)) name = null;
        return { chat_id: id, position, message_id, name };
      });
    }
    const attributes: Insertable<ChatTables["chat.attributes"]>[] = [
      {
        chat_id: id,
        key: "bookmarkNames",
        value: JSON.stringify(encodeJsonValue(names ?? null)),
      },
    ];
    const clearedAttributeKeys: (keyof ChatUpdate)[] = [];
    if (
      bookmarks === undefined ||
      !bookmarks.length ||
      containsNul(bookmarks)
    ) {
      attributes.push({
        chat_id: id,
        key: "bookmarks",
        value: JSON.stringify(encodeJsonValue(bookmarks ?? null)),
      });
    } else {
      clearedAttributeKeys.push("bookmarks");
    }
    return { rows, attributes, clearedAttributeKeys };
  },
};
