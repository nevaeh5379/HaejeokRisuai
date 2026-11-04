import type { Insertable } from "kysely";
import type {
  CharacterFields,
  CharacterUpdate,
} from "../../../../../../packages/protocol/domain/character.ts";
import type { CharacterTables } from "../../../../../../packages/protocol/tables/character.ts";
import {
  CHARACTER_FIELD_COLUMNS,
  CHARACTER_RELATIONS,
  containsNul,
} from "../../relationalCodec.ts";
import { encodePostgresJsonValue } from "../../jsonCodec.ts";

export type Rows = Insertable<CharacterTables["character.attributes"]>[];
export type Keys = (keyof CharacterFields)[];

export const Attributes = {
  fromPatch(id: string, patch: CharacterUpdate) {
    const attributes: Rows = [];
    const attributeKeys: Keys = [];
    for (const key of Object.keys(patch) as Keys) {
      if (key === "chaId" || key === "type") continue;
      attributeKeys.push(key);
      const value = patch[key];
      if (
        value !== undefined &&
        (containsNul(value) ||
          (!Object.hasOwn(CHARACTER_FIELD_COLUMNS, key) &&
            !Object.hasOwn(CHARACTER_RELATIONS, key)) ||
          (Array.isArray(value) && !value.length))
      )
        attributes.push({
          character_id: id,
          key,
          value: JSON.stringify(encodePostgresJsonValue(value)),
        });
    }
    return { attributes, attributeKeys };
  },
};
