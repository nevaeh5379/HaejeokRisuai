import type { SqlCommit } from "./sqlCommit";
import {
  flattenRelationalValue,
  RELATIONAL_NODE_COLUMNS,
  type RelationalNodeRow,
} from "./relationalNodeCodec";

export type SqliteExecute = (
  sql: string,
  bind?: unknown[],
) => void | Promise<void>;

export function presetContentHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${serialized.length}-${(hash >>> 0).toString(16)}`;
}

const SETTING_DOMAINS: Record<string, ReadonlySet<string>> = {
  model: new Set([
    "apiType",
    "aiModel",
    "subModel",
    "temperature",
    "maxContext",
    "maxResponse",
    "frequencyPenalty",
    "PresensePenalty",
    "bias",
    "customModels",
    "fallbackModels",
  ]),
  provider: new Set([
    "openAIKey",
    "proxyKey",
    "forceReplaceUrl",
    "openrouterKey",
    "claudeAPIKey",
    "nanogptKey",
    "koboldURL",
    "textgenWebUIStreamURL",
    "textgenWebUIBlockingURL",
    "OaiCompAPIKeys",
  ]),
  prompt: new Set([
    "mainPrompt",
    "jailbreak",
    "globalNote",
    "additionalPrompt",
    "descriptionPrefix",
    "promptTemplate",
    "promptSettings",
    "instructChatTemplate",
    "JinjaTemplate",
    "globalscript",
  ]),
  memory: new Set([
    "supaMemoryPrompt",
    "supaMemoryKey",
    "hypaMemoryKey",
    "voyageApiKey",
    "hypaMemory",
    "hypav2",
    "hypaModel",
    "memoryAlgorithmType",
  ]),
  translation: new Set([
    "language",
    "translator",
    "translatorType",
    "translatorInputLanguage",
    "autoTranslate",
    "useAutoTranslateInput",
    "deeplOptions",
    "deeplXOptions",
  ]),
  media: new Set([
    "sdProvider",
    "webUiUrl",
    "sdSteps",
    "sdCFG",
    "sdConfig",
    "NAIImgUrl",
    "NAIApiKey",
    "NAIImgModel",
    "NAIImgConfig",
    "ttsAutoSpeech",
    "elevenLabKey",
    "voicevoxUrl",
  ]),
  ui: new Set([
    "zoomsize",
    "customBackground",
    "fullScreen",
    "iconsize",
    "theme",
    "textTheme",
    "customTextTheme",
    "colorScheme",
    "colorSchemeName",
    "customColorScheme",
    "characterOrder",
    "hotkeys",
  ]),
  collection: new Set([
    "botPresets",
    "personas",
    "modules",
    "moduleFolders",
    "loreBook",
    "loadouts",
    "plugins",
    "pluginV2",
    "translatorPresets",
  ]),
};

export function settingDomain(key: string): string {
  for (const [domain, keys] of Object.entries(SETTING_DOMAINS))
    if (keys.has(key)) return domain;
  return "account-sync-compatibility";
}

function nodeBind(ownerValues: unknown[], row: RelationalNodeRow): unknown[] {
  return [
    ...ownerValues,
    ...RELATIONAL_NODE_COLUMNS.map((column) => row[column]),
  ];
}

const RELATIONAL_NODE_BATCH_SIZE = 128;

async function replaceNodes(
  execute: SqliteExecute,
  table: string,
  ownerColumns: string[],
  ownerValues: unknown[],
  value: unknown,
): Promise<void> {
  const rows = flattenRelationalValue(value);
  const ownerWhere = ownerColumns
    .map((column) => `${column} = ?`)
    .join(" AND ");

  // Node IDs are dense preorder indices. Preserve the existing prefix and only
  // remove rows which no longer exist after the value shrinks. This avoids
  // turning a one-leaf edit into a full DELETE + INSERT rewrite of the tree.
  await execute(`DELETE FROM ${table} WHERE ${ownerWhere} AND node_id >= ?`, [
    ...ownerValues,
    rows.length,
  ]);

  const columns = [...ownerColumns, ...RELATIONAL_NODE_COLUMNS];
  const conflictColumns = [...ownerColumns, "node_id"];
  const mutableColumns = RELATIONAL_NODE_COLUMNS.filter(
    (column) => column !== "node_id",
  );
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const updateClause = mutableColumns
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  const changedClause = mutableColumns
    .map((column) => `${table}.${column} IS NOT excluded.${column}`)
    .join(" OR ");

  for (let offset = 0; offset < rows.length; offset += RELATIONAL_NODE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + RELATIONAL_NODE_BATCH_SIZE);
    await execute(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${batch
        .map(() => rowPlaceholders)
        .join(", ")}
       ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${updateClause}
       WHERE ${changedClause}`,
      batch.flatMap((row) => nodeBind(ownerValues, row)),
    );
  }
}

async function replaceCharacterTags(
  execute: SqliteExecute,
  characterId: string,
  value: unknown,
): Promise<void> {
  const tags = Array.isArray(value) ? value : [];
  await execute(
    "DELETE FROM character_tags WHERE character_id = ? AND position >= ?",
    [characterId, tags.length],
  );

  const stringTags: { position: number; tag: string }[] = [];
  const removedPositions: number[] = [];
  for (const [position, tag] of tags.entries()) {
    if (typeof tag === "string") stringTags.push({ position, tag });
    else removedPositions.push(position);
  }

  for (let offset = 0; offset < removedPositions.length; offset += 256) {
    const batch = removedPositions.slice(offset, offset + 256);
    await execute(
      `DELETE FROM character_tags WHERE character_id = ? AND position IN (${batch
        .map(() => "?")
        .join(", ")})`,
      [characterId, ...batch],
    );
  }

  for (let offset = 0; offset < stringTags.length; offset += 256) {
    const batch = stringTags.slice(offset, offset + 256);
    await execute(
      `INSERT INTO character_tags (character_id, position, tag) VALUES ${batch
        .map(() => "(?, ?, ?)")
        .join(", ")}
       ON CONFLICT (character_id, position) DO UPDATE SET tag=excluded.tag
       WHERE character_tags.tag IS NOT excluded.tag`,
      batch.flatMap(({ position, tag }) => [characterId, position, tag]),
    );
  }
}

function coldKind(value: unknown): string {
  if (Array.isArray(value)) return "legacy";
  if (value && typeof value === "object" && "character" in value)
    return "character";
  if (value && typeof value === "object" && "message" in value) return "chat";
  return "unknown";
}

export async function writeSqliteColdStorage(
  execute: SqliteExecute,
  key: string,
  value: unknown,
): Promise<void> {
  await execute(
    `INSERT INTO cold_archives (archive_id, archive_kind, updated_at)
        VALUES (?, ?, datetime('now')) ON CONFLICT(archive_id) DO UPDATE SET
        archive_kind=excluded.archive_kind, updated_at=datetime('now')`,
    [key, coldKind(value)],
  );
  await replaceNodes(
    execute,
    "cold_extension_nodes",
    ["archive_id"],
    [key],
    value,
  );
}

export async function applySqliteCommit(
  commit: SqlCommit,
  execute: SqliteExecute,
): Promise<void> {
  if (commit.replaceAll) {
    await execute("DELETE FROM plugin_custom_storage");
    await execute("DELETE FROM bot_presets");
  }
  for (const upsert of commit.root.upserts) {
    if (upsert.key === "botPresets" || upsert.key === "botPresetsId")
      throw new Error(`${upsert.key} must be written through presets`);
    if (upsert.key === "pluginCustomStorage") continue;
    const root = flattenRelationalValue(upsert.value)[0];
    await execute(
      `INSERT INTO system_settings
            (key, domain, value_type, text_value, encoded_text_value, number_value, boolean_value, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET
            domain=excluded.domain, value_type=excluded.value_type, text_value=excluded.text_value,
            encoded_text_value=excluded.encoded_text_value, number_value=excluded.number_value,
            boolean_value=excluded.boolean_value, updated_at=datetime('now')`,
      [
        upsert.key,
        settingDomain(upsert.key),
        root.value_type,
        root.text_value,
        root.encoded_text_value,
        root.number_value,
        root.boolean_value,
      ],
    );
    await replaceNodes(
      execute,
      "setting_extension_nodes",
      ["setting_key"],
      [upsert.key],
      upsert.value,
    );
  }
  for (const key of commit.root.deletes) {
    if (key === "botPresets" || key === "botPresetsId")
      throw new Error(`${key} is not a root setting`);
    await execute("DELETE FROM system_settings WHERE key = ?", [key]);
  }

  if (commit.pluginStorage) {
    if (commit.pluginStorage.clear)
      await execute("DELETE FROM plugin_custom_storage");
    for (const key of commit.pluginStorage.deletes)
      await execute("DELETE FROM plugin_custom_storage WHERE key = ?", [key]);
    for (const upsert of commit.pluginStorage.upserts) {
      await execute(
        `INSERT INTO plugin_custom_storage (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
        [upsert.key, JSON.stringify(upsert.value)],
      );
    }
  }

  if (commit.presets) {
    for (const id of commit.presets.deletes) {
      await execute("DELETE FROM bot_presets WHERE preset_id = ?", [id]);
    }
    for (const entry of commit.presets.upserts) {
      const data = { ...entry.data } as Record<string, unknown>;
      delete data.id;
      const serialized = JSON.stringify(data);
      const position = entry.position ?? 0;
      await execute(
        `INSERT INTO bot_presets
                (preset_id, position, name, image, api_type, ai_model, data, content_hash, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(preset_id) DO UPDATE SET position=excluded.position,
                name=excluded.name, image=excluded.image, api_type=excluded.api_type,
                ai_model=excluded.ai_model, data=excluded.data,
                content_hash=excluded.content_hash, updated_at=datetime('now')`,
        [
          entry.id,
          position,
          data.name ?? "",
          data.image ?? "",
          data.apiType ?? "",
          data.aiModel ?? "",
          serialized,
          presetContentHash(data),
        ],
      );
    }
    if (commit.presets.order) {
      await execute("UPDATE bot_presets SET position = position + 1000000000");
      for (const [position, id] of commit.presets.order.entries()) {
        await execute(
          "UPDATE bot_presets SET position = ? WHERE preset_id = ?",
          [position, id],
        );
      }
    }
    if (commit.presets.activeId !== undefined) {
      const value = commit.presets.activeId;
      const root = flattenRelationalValue(value)[0];
      await execute(
        `INSERT INTO system_settings
                (key, domain, value_type, text_value, encoded_text_value, number_value, boolean_value, updated_at)
                VALUES ('activeBotPresetId', 'model', ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value_type=excluded.value_type,
                text_value=excluded.text_value, encoded_text_value=excluded.encoded_text_value,
                number_value=excluded.number_value, boolean_value=excluded.boolean_value,
                updated_at=datetime('now')`,
        [
          root.value_type,
          root.text_value,
          root.encoded_text_value,
          root.number_value,
          root.boolean_value,
        ],
      );
      await replaceNodes(
        execute,
        "setting_extension_nodes",
        ["setting_key"],
        ["activeBotPresetId"],
        value,
      );
    }
  }

  for (const entry of commit.characters) {
    const data = entry.data as Record<string, unknown>;
    await execute(
      `INSERT INTO characters
            (id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(id) DO UPDATE SET
            position=excluded.position, kind=excluded.kind, name=excluded.name, image=excluded.image,
            trash_time=excluded.trash_time, creation_time=excluded.creation_time,
            modification_time=excluded.modification_time, last_interaction_time=excluded.last_interaction_time,
            details_loaded=1, updated_at=datetime('now')`,
      [
        entry.id,
        entry.position,
        data.type === "group" ? "group" : "character",
        data.name ?? "",
        data.image ?? null,
        data.trashTime ?? null,
        data.creationDate ?? data.creation_date ?? null,
        data.modificationDate ?? data.modification_date ?? null,
        data.lastInteraction ?? null,
      ],
    );
    await replaceNodes(
      execute,
      "character_extension_nodes",
      ["character_id"],
      [entry.id],
      data,
    );
    await replaceCharacterTags(execute, entry.id, data.tags);
  }
  for (const touch of commit.characterTouches ?? []) {
    await execute(
      "UPDATE characters SET last_interaction_time = ?, updated_at = datetime('now') WHERE id = ?",
      [touch.lastInteraction, touch.id],
    );
  }

  if (commit.characterIds !== undefined) {
    if (!commit.characterIds.length) await execute("DELETE FROM characters");
    else
      await execute(
        `DELETE FROM characters WHERE id NOT IN (${commit.characterIds.map(() => "?").join(",")})`,
        commit.characterIds,
      );
  }

  for (const entry of commit.chats) {
    const data = entry.data as Record<string, unknown>;
    await execute(
      `INSERT INTO chats
            (id, character_id, position, name, note, folder_id, last_message_time, messages_loaded, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now')) ON CONFLICT(id) DO UPDATE SET
            character_id=excluded.character_id, position=excluded.position, name=excluded.name,
            note=excluded.note, folder_id=excluded.folder_id, last_message_time=excluded.last_message_time,
            updated_at=datetime('now')`,
      [
        entry.id,
        entry.characterId,
        entry.position,
        data.name ?? "",
        data.note ?? "",
        data.folderId ?? null,
        data.lastDate ?? null,
      ],
    );
    await replaceNodes(
      execute,
      "chat_extension_nodes",
      ["chat_id"],
      [entry.id],
      data,
    );
  }
  for (const manifest of commit.chatManifests) {
    if (!manifest.ids.length)
      await execute("DELETE FROM chats WHERE character_id = ?", [
        manifest.characterId,
      ]);
    else
      await execute(
        `DELETE FROM chats WHERE character_id = ? AND id NOT IN (${manifest.ids.map(() => "?").join(",")})`,
        [manifest.characterId, ...manifest.ids],
      );
  }

  for (const entry of commit.messages) {
    const data = entry.data as Record<string, any>;
    const content = flattenRelationalValue(
      typeof data.data === "string" ? data.data : String(data.data ?? ""),
    )[0];
    await execute(
      `INSERT INTO messages
            (chat_id, id, position, role, content_text, content_encoded, sender_name, sent_time, generation_model, input_tokens, output_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id,id) DO UPDATE SET
            position=excluded.position, role=excluded.role, content_text=excluded.content_text,
            content_encoded=excluded.content_encoded, sender_name=excluded.sender_name,
            sent_time=excluded.sent_time, generation_model=excluded.generation_model,
            input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens`,
      [
        entry.chatId,
        entry.id,
        entry.position,
        data.role ?? "char",
        content.text_value,
        content.encoded_text_value,
        data.name ?? null,
        data.time ?? null,
        data.generationInfo?.model ?? null,
        data.generationInfo?.inputTokens ?? null,
        data.generationInfo?.outputTokens ?? null,
      ],
    );
    await replaceNodes(
      execute,
      "message_extension_nodes",
      ["chat_id", "message_id"],
      [entry.chatId, entry.id],
      data,
    );
  }
  for (const manifest of commit.messageManifests) {
    if (!manifest.ids.length)
      await execute("DELETE FROM messages WHERE chat_id = ?", [
        manifest.chatId,
      ]);
    else
      await execute(
        `DELETE FROM messages WHERE chat_id = ? AND id NOT IN (${manifest.ids.map(() => "?").join(",")})`,
        [manifest.chatId, ...manifest.ids],
      );
  }
  for (const deletion of commit.messageDeletes ?? [])
    if (deletion.ids.length) {
      await execute(
        `DELETE FROM messages WHERE chat_id = ? AND id IN (${deletion.ids.map(() => "?").join(",")})`,
        [deletion.chatId, ...deletion.ids],
      );
    }
}
