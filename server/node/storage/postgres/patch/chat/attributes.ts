import type { Insertable } from "kysely";
import type { ChatUpdate } from "../../../../../../packages/protocol/domain/chat.ts";
import type { ChatTables } from "../../../../../../packages/protocol/tables/chat.ts";
import { CHAT_FIELD_STORAGE, containsNul } from "../../relationalCodec.ts";
import { encodeJsonValue } from "../../jsonCodec.ts";

export type Rows = Insertable<ChatTables["chat.attributes"]>[];
export type Keys = (keyof ChatUpdate)[];

export const Attributes = {
  fromPatch(id: string, patch: ChatUpdate) {
    const attributes: Rows = [];
    const clearedAttributeKeys: Keys = [];
    for (const key of Object.keys(patch) as Keys) {
      if (key === "bookmarks" || key === "bookmarkNames") continue;
      const value = patch[key];
      if (value === undefined) continue;
      const storage = CHAT_FIELD_STORAGE[key];
      const storeAttribute =
        value !== undefined &&
        (storage.kind === "attribute" ||
          (containsNul(value) &&
            key !== "hypaV2Data" &&
            key !== "hypaV3Data") ||
          (Array.isArray(value) && !value.length) ||
          (key === "scriptstate" && Object.keys(value).length === 0));
      if (storeAttribute) {
        attributes.push({
          chat_id: id,
          key,
          value: JSON.stringify(encodeJsonValue(value)),
        });
      } else {
        clearedAttributeKeys.push(key);
      }
    }
    return { attributes, clearedAttributeKeys };
  },
};
