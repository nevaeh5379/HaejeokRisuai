import type { Updateable } from "kysely";
import type {
  CharacterFields,
  CharacterUpdate,
} from "../../../../../../packages/protocol/domain/character.ts";
import type { CharactersTable } from "../../../../../../packages/protocol/tables/character.ts";
import { CHARACTER_FIELD_COLUMNS, containsNul } from "../../relationalCodec.ts";
import { Attributes } from "./attributes.ts";
import { Relation } from "./relation.ts";

export function getColumn(patch: CharacterUpdate): Updateable<CharactersTable> {
  const columns: Updateable<CharactersTable> = {};
  for (const key of Object.keys(patch) as (keyof CharacterFields)[]) {
    if (!Object.hasOwn(CHARACTER_FIELD_COLUMNS, key)) continue;
    const column =
      CHARACTER_FIELD_COLUMNS[key as keyof typeof CHARACTER_FIELD_COLUMNS];
    let value: CharacterUpdate[keyof CharacterUpdate] | null = patch[key];
    if (containsNul(value) || value === undefined) {
      value = column === "name" || column === "first_message" ? "" : null;
    }

    // The field map pairs domain values with their corresponding SQL columns.
    Object.assign(columns, { [column]: value });
  }
  return columns;
}

/** PostgreSQL write inputs derived from the table declarations. */
export function characterPatch(id: string, patch: CharacterUpdate) {
  const columns = getColumn(patch);
  const relations = Relation.fromPatch(id, patch);
  const { attributes, attributeKeys } = Attributes.fromPatch(id, patch);
  return { columns, relations, attributes, attributeKeys };
}
