import type { Insertable, Updateable } from "kysely";
import type {
  CharacterFields,
  CharacterUpdate,
} from "../../../../packages/protocol/domain/character.ts";
import type {
  CharacterTables,
  CharactersTable,
} from "../../../../packages/protocol/tables/character.ts";
import {
  CHARACTER_FIELD_COLUMNS,
  CHARACTER_RELATIONS,
  containsNul,
} from "./postgresRelationalCodec.ts";
import { encodePostgresJsonValue } from "./postgresJsonCodec.ts";

type RelationKey = keyof typeof CHARACTER_RELATIONS;
type RelationRows = {
  [K in RelationKey]?: Insertable<
    CharacterTables[(typeof CHARACTER_RELATIONS)[K]["table"]]
  >[];
};

export function getColumn(patch: CharacterUpdate): Updateable<CharactersTable> {
  const columns: Updateable<CharactersTable> = {};
  for (const key of Object.keys(patch) as (keyof CharacterFields)[]) {
    if (!Object.hasOwn(CHARACTER_FIELD_COLUMNS, key)) continue;
    const column =
      CHARACTER_FIELD_COLUMNS[key as keyof typeof CHARACTER_FIELD_COLUMNS];
    let value: CharacterUpdate[keyof CharacterUpdate] | null = patch[key];
    if (containsNul(value) || value === undefined)
      value = column === "name" || column === "first_message" ? "" : null;

    // The field map pairs domain values with their corresponding SQL columns.
    Object.assign(columns, { [column]: value });
  }
  return columns;
}

type RelationItem<K extends RelationKey> = NonNullable<
  CharacterUpdate[K]
>[number];
type RelationMappers = {
  [K in RelationKey]: (
    value: RelationItem<K>,
  ) => Omit<NonNullable<RelationRows[K]>[number], "character_id" | "position">;
};

const relationMappers: RelationMappers = {
  tags: (tag) => ({
    tag,
  }),
  bias: ([phrase, bias]) => ({
    phrase,
    bias,
  }),
  emotionImages: ([emotion, asset]) => ({
    emotion,
    asset,
  }),
  modules: (module_id) => ({
    module_id,
  }),
  alternateGreetings: (content) => ({
    greeting_type: "alternate",
    content,
  }),
  group_only_greetings: (content) => ({
    greeting_type: "group-only",
    content,
  }),
  sdData: ([key, value]) => ({
    key,
    value,
  }),
  customscript: (script) => ({
    script_kind: "custom",
    comment: script.comment ?? null,
    input_text: script.in ?? null,
    output_text: script.out ?? null,
    script_type: script.type ?? null,
    flag: script.flag ?? null,
    able_flag: script.ableFlag ?? null,
    trigger_payload: null,
  }),
  triggerscript: (script) => ({
    script_kind: "trigger",
    comment: script.comment ?? null,
    input_text: null,
    output_text: null,
    script_type: script.type ?? null,
    flag: null,
    able_flag: null,
    trigger_payload: JSON.stringify(encodePostgresJsonValue(script)),
  }),
  additionalAssets: ([name, uri, extension]) => ({
    asset_source: "additional",
    asset_type: null,
    uri: uri ?? null,
    name: name ?? null,
    extension: extension ?? null,
    extra_value: null,
  }),
  ccAssets: (asset) => ({
    asset_source: "character-card",
    asset_type: asset.type ?? null,
    uri: asset.uri ?? null,
    name: asset.name ?? null,
    extension: asset.ext ?? null,
    extra_value: null,
  }),
  globalLore: (entry) => ({
    lore_id: entry.id ?? null,
    primary_key: entry.key ?? "",
    secondary_key: entry.secondkey ?? "",
    insert_order: entry.insertorder ?? 0,
    comment: entry.comment ?? "",
    content: entry.content ?? "",
    mode: entry.mode ?? "normal",
    always_active: entry.alwaysActive ?? false,
    selective: entry.selective ?? false,
    case_sensitive: entry.extentions?.risu_case_sensitive ?? null,
    activation_percent: entry.activationPercent ?? null,
    use_regex: entry.useRegex ?? null,
    book_version: entry.bookVersion ?? null,
    folder: entry.folder ?? null,
    cache_payload:
      entry.loreCache === undefined
        ? null
        : JSON.stringify(encodePostgresJsonValue(entry.loreCache)),
  }),
};

function getRelationRows<K extends RelationKey>(
  id: string,
  key: K,
  patch: CharacterUpdate,
) {
  const value = patch[key];
  // Unsafe relational values are preserved as encoded attributes instead.
  const items = (
    containsNul(value) ? [] : (value ?? [])
  ) as readonly RelationItem<K>[];
  return items.map((item, position) => ({
    character_id: id,
    position,
    ...relationMappers[key](item),
  }));
}

function getRelations(id: string, patch: CharacterUpdate): RelationRows {
  const relations: RelationRows = {};
  for (const key of Object.keys(patch) as RelationKey[]) {
    if (!Object.hasOwn(relationMappers, key)) continue;
    Object.assign(relations, { [key]: getRelationRows(id, key, patch) });
  }
  return relations;
}

function getAttributes(id: string, patch: CharacterUpdate) {
  const attributes: Insertable<CharacterTables["character.attributes"]>[] = [];
  const attributeKeys: (keyof CharacterFields)[] = [];
  for (const key of Object.keys(patch) as (keyof CharacterFields)[]) {
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
}

/** PostgreSQL write inputs derived from the table declarations. */
export function characterPatch(id: string, patch: CharacterUpdate) {
  const columns = getColumn(patch);
  const relations = getRelations(id, patch);
  const { attributes, attributeKeys } = getAttributes(id, patch);
  return { columns, relations, attributes, attributeKeys };
}
