import { encodePostgresJsonValue } from "../../jsonCodec.ts";
import type { CharacterUpdate } from "../../../../../../packages/protocol/domain/character.ts";
import type { Insertable } from "kysely";
import type { CharacterTables } from "../../../../../../packages/protocol/tables/character.ts";
import { CHARACTER_RELATIONS, containsNul } from "../../relationalCodec.ts";

export type Key = keyof typeof CHARACTER_RELATIONS;
export type Rows = {
  [K in Key]?: Insertable<
    CharacterTables[(typeof CHARACTER_RELATIONS)[K]["table"]]
  >[];
};

type RelationItem<K extends Key> = NonNullable<CharacterUpdate[K]>[number];
type RelationMappers = {
  [K in Key]: (
    value: RelationItem<K>,
  ) => Omit<NonNullable<Rows[K]>[number], "character_id" | "position">;
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

function getRows<K extends Key>(id: string, key: K, patch: CharacterUpdate) {
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
export const Relation = {
  fromPatch(id: string, patch: CharacterUpdate): Rows {
    const relations: Rows = {};
    for (const key of Object.keys(patch) as Key[]) {
      if (!Object.hasOwn(relationMappers, key)) continue;
      Object.assign(relations, { [key]: getRows(id, key, patch) });
    }
    return relations;
  },
};
