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

/** PostgreSQL write inputs derived from the table declarations. */
export function characterPatch(id: string, patch: CharacterUpdate) {
  const columns: Updateable<CharactersTable> = {};
  const values = {
    name: patch.name,
    image: patch.image,
    first_message: patch.firstMessage,
    description: patch.desc,
    notes: patch.notes,
    creator_notes: patch.creatorNotes,
    system_prompt: patch.systemPrompt,
    post_history_instructions: patch.postHistoryInstructions,
    personality: patch.personality,
    scenario: patch.scenario,
    example_message: patch.exampleMessage,
    creator: patch.creator,
    character_version: patch.characterVersion,
    nickname: patch.nickname,
    view_screen: patch.viewScreen,
    first_message_index: patch.firstMsgIndex,
    utility_bot: patch.utilityBot,
    is_private: patch.private,
    realm_id: patch.realmId,
    license: patch.license,
    default_variables: patch.defaultVariables,
    additional_text: patch.additionalText,
    translator_note: patch.translatorNote,
    background_html: patch.backgroundHTML,
    background_css: patch.backgroundCSS,
    creation_time: patch.creation_date,
    modification_time: patch.modification_date,
    last_interaction_time: patch.lastInteraction,
    trash_time: patch.trashTime,
  } satisfies Updateable<CharactersTable>;
  const relations: RelationRows = {};
  const attributes: Insertable<CharacterTables["character.attributes"]>[] = [];
  const attributeKeys: (keyof CharacterFields)[] = [];
  for (const key of Object.keys(patch) as (keyof CharacterFields)[]) {
    if (key === "chaId" || key === "type") continue;
    const value = patch[key];
    const unsafe = containsNul(value);
    const hasColumn = Object.hasOwn(CHARACTER_FIELD_COLUMNS, key);
    const hasRelation = Object.hasOwn(CHARACTER_RELATIONS, key);
    attributeKeys.push(key);
    if (hasColumn) {
      const column =
        CHARACTER_FIELD_COLUMNS[key as keyof typeof CHARACTER_FIELD_COLUMNS];
      // The field map pairs domain values with their corresponding SQL columns.
      Object.assign(columns, {
        [column]:
          unsafe || value === undefined
            ? column === "name" || column === "first_message"
              ? ""
              : null
            : values[column],
      });
    }
    // Unsafe relational values are preserved as encoded attributes instead.
    const data = unsafe ? {} : patch;
    switch (key) {
      case "tags":
        relations.tags = (data.tags ?? []).map((tag, position) => ({
          character_id: id,
          position,
          tag,
        }));
        break;
      case "bias":
        relations.bias = (data.bias ?? []).map(([phrase, bias], position) => ({
          character_id: id,
          position,
          phrase,
          bias,
        }));
        break;
      case "emotionImages":
        relations.emotionImages = (data.emotionImages ?? []).map(
          ([emotion, asset], position) => ({
            character_id: id,
            position,
            emotion,
            asset,
          }),
        );
        break;
      case "modules":
        relations.modules = (data.modules ?? []).map((module_id, position) => ({
          character_id: id,
          position,
          module_id,
        }));
        break;
      case "alternateGreetings":
        relations.alternateGreetings = (data.alternateGreetings ?? []).map(
          (content, position) => ({
            character_id: id,
            position,
            greeting_type: "alternate",
            content,
          }),
        );
        break;
      case "group_only_greetings":
        relations.group_only_greetings = (data.group_only_greetings ?? []).map(
          (content, position) => ({
            character_id: id,
            position,
            greeting_type: "group-only",
            content,
          }),
        );
        break;
      case "sdData":
        relations.sdData = (data.sdData ?? []).map(
          ([key, value], position) => ({
            character_id: id,
            position,
            key,
            value,
          }),
        );
        break;
      case "customscript":
        relations.customscript = (data.customscript ?? []).map(
          (script, position) => ({
            character_id: id,
            position,
            script_kind: "custom",
            comment: script.comment ?? null,
            input_text: script.in ?? null,
            output_text: script.out ?? null,
            script_type: script.type ?? null,
            flag: script.flag ?? null,
            able_flag: script.ableFlag ?? null,
            trigger_payload: null,
          }),
        );
        break;
      case "triggerscript":
        relations.triggerscript = (data.triggerscript ?? []).map(
          (script, position) => ({
            character_id: id,
            position,
            script_kind: "trigger",
            comment: script.comment ?? null,
            input_text: null,
            output_text: null,
            script_type: script.type ?? null,
            flag: null,
            able_flag: null,
            trigger_payload: JSON.stringify(encodePostgresJsonValue(script)),
          }),
        );
        break;
      case "additionalAssets":
        relations.additionalAssets = (data.additionalAssets ?? []).map(
          ([name, uri, extension], position) => ({
            character_id: id,
            position,
            asset_source: "additional",
            asset_type: null,
            uri: uri ?? null,
            name: name ?? null,
            extension: extension ?? null,
            extra_value: null,
          }),
        );
        break;
      case "ccAssets":
        relations.ccAssets = (data.ccAssets ?? []).map((asset, position) => ({
          character_id: id,
          position,
          asset_source: "character-card",
          asset_type: asset.type ?? null,
          uri: asset.uri ?? null,
          name: asset.name ?? null,
          extension: asset.ext ?? null,
          extra_value: null,
        }));
        break;
      case "globalLore":
        relations.globalLore = (data.globalLore ?? []).map(
          (entry, position) => ({
            character_id: id,
            position,
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
        );
        break;
    }
    if (
      value !== undefined &&
      (unsafe ||
        (!hasColumn && !hasRelation) ||
        (Array.isArray(value) && !value.length))
    )
      attributes.push({
        character_id: id,
        key,
        value: JSON.stringify(encodePostgresJsonValue(value)),
      });
  }
  return { columns, relations, attributes, attributeKeys };
}
