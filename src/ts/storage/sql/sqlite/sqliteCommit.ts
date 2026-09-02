import type { SqlCommit } from "../sqlCommit";
import { isLegacyPersonaMirrorKey } from "../sqlDeferredSettings";
import {
  flattenRelationalValue,
  MAX_RELATIONAL_NODE_DEPTH,
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
    "seperateModels",
    "providerModelOverrides",
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

function assertCanonicalRootSetting(key: string): void {
  if (isLegacyPersonaMirrorKey(key)) {
    throw new Error(`${key} is a legacy persona mirror and cannot be persisted`);
  }
}

function nodeBind(ownerValues: unknown[], row: RelationalNodeRow): unknown[] {
  return [
    ...ownerValues,
    ...RELATIONAL_NODE_COLUMNS.map((column) => row[column]),
  ];
}

const RELATIONAL_NODE_BATCH_SIZE = 128;
const CHARACTER_TAG_BATCH_SIZE = 256;

function countRelationalValueNodes(value: unknown): number {
  let count = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_RELATIONAL_NODE_DEPTH) {
      throw new Error(
        `Relational value exceeds maximum depth ${MAX_RELATIONAL_NODE_DEPTH}`,
      );
    }
    count++;
    if (
      current === null ||
      current === undefined ||
      typeof current === "boolean" ||
      typeof current === "number" ||
      typeof current === "string"
    ) return;
    if (typeof current !== "object") {
      throw new TypeError(`Unsupported relational value type: ${typeof current}`);
    }
    if (ancestors.has(current)) {
      throw new TypeError("Relational values cannot contain cycles");
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
    } else {
      for (const key of Object.keys(current)) {
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(current);
  };

  visit(value, 0);
  return count;
}

function countReplaceNodeStatements(
  value: unknown,
  skipDelete = false,
): number {
  return (skipDelete ? 0 : 1) +
    Math.ceil(countRelationalValueNodes(value) / RELATIONAL_NODE_BATCH_SIZE);
}

function countCharacterTagStatements(value: unknown): number {
  const tags = Array.isArray(value) ? value : [];
  let strings = 0;
  let removed = 0;
  for (const tag of tags) {
    if (typeof tag === "string") strings++;
    else removed++;
  }
  return 1 +
    Math.ceil(strings / CHARACTER_TAG_BATCH_SIZE) +
    Math.ceil(removed / CHARACTER_TAG_BATCH_SIZE);
}

export function messageExtensionData(
  data: Record<string, any>,
  content: RelationalNodeRow,
): Record<string, unknown> {
  const extension: Record<string, any> = { ...data };
  delete extension.role;
  delete extension.name;
  delete extension.time;

  // Normal message text already lives in messages.content_text. Keep the
  // relational copy only for strings SQLite cannot represent safely.
  if (content.encoded_text_value == null) delete extension.data;

  const generationInfo = extension.generationInfo;
  if (
    generationInfo &&
    typeof generationInfo === "object" &&
    !Array.isArray(generationInfo)
  ) {
    const extraGenerationInfo = { ...generationInfo };
    delete extraGenerationInfo.model;
    delete extraGenerationInfo.inputTokens;
    delete extraGenerationInfo.outputTokens;
    if (Object.keys(extraGenerationInfo).length > 0) {
      extension.generationInfo = extraGenerationInfo;
    } else {
      delete extension.generationInfo;
    }
  }
  return extension;
}

async function replaceNodes(
  execute: SqliteExecute,
  table: string,
  ownerColumns: string[],
  ownerValues: unknown[],
  value: unknown,
  skipDelete = false,
): Promise<void> {
  const rows = flattenRelationalValue(value);
  const ownerWhere = ownerColumns
    .map((column) => `${column} = ?`)
    .join(" AND ");

  // Explicit replace-entities restore batches run after the parent rows were
  // CASCADE-deleted, so there is no old node tail to trim in that path.
  if (!skipDelete) {
    await execute(`DELETE FROM ${table} WHERE ${ownerWhere} AND node_id >= ?`, [
      ...ownerValues,
      rows.length,
    ]);
  }

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

  for (
    let offset = 0;
    offset < removedPositions.length;
    offset += CHARACTER_TAG_BATCH_SIZE
  ) {
    const batch = removedPositions.slice(offset, offset + CHARACTER_TAG_BATCH_SIZE);
    await execute(
      `DELETE FROM character_tags WHERE character_id = ? AND position IN (${batch
        .map(() => "?")
        .join(", ")})`,
      [characterId, ...batch],
    );
  }

  for (
    let offset = 0;
    offset < stringTags.length;
    offset += CHARACTER_TAG_BATCH_SIZE
  ) {
    const batch = stringTags.slice(offset, offset + CHARACTER_TAG_BATCH_SIZE);
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

export function countSqliteCommitStatements(commit: SqlCommit): number {
  let total = commit.replaceAll ? 3 : 0;
  const replacingEntities = commit.action === "replace-entities";

  for (const upsert of commit.root.upserts) {
    assertCanonicalRootSetting(upsert.key);
    if (upsert.key === "botPresets" || upsert.key === "botPresetsId") {
      throw new Error(`${upsert.key} must be written through presets`);
    }
    if (upsert.key === "pluginCustomStorage") continue;
    total += 1 + countReplaceNodeStatements(upsert.value);
  }
  for (const key of commit.root.deletes) {
    if (key === "botPresets" || key === "botPresetsId") {
      throw new Error(`${key} is not a root setting`);
    }
    total++;
  }

  if (commit.pluginStorage) {
    if (commit.pluginStorage.clear) total++;
    total += commit.pluginStorage.deletes.length;
    total += commit.pluginStorage.upserts.length;
  }

  if (commit.presets) {
    total += commit.presets.deletes.length;
    total += commit.presets.upserts.length;
    if (commit.presets.order) total += 1 + commit.presets.order.length;
    if (commit.presets.activeId !== undefined) {
      total += 1 + countReplaceNodeStatements(commit.presets.activeId);
    }
  }

  if (commit.modules) {
    total += commit.modules.deletes.length;
    total += commit.modules.upserts.reduce(
      (count, entry) => count + 1 + countReplaceNodeStatements(entry.data),
      0,
    );
    if (commit.modules.order) total += 1 + commit.modules.order.length;
  }

  for (const entry of commit.characters) {
    const data = entry.data as Record<string, unknown>;
    total += 1 + countReplaceNodeStatements(data, replacingEntities);
    total += countCharacterTagStatements(data.tags);
  }
  total += commit.characterTouches?.length ?? 0;
  total += commit.characterDeletes?.length ?? 0;

  for (const entry of commit.chats) {
    total += 3 + countReplaceNodeStatements(entry.data, replacingEntities);
  }
  total += commit.chatDeletes?.length ?? 0;

  for (const entry of commit.messages) {
    const data = entry.data as Record<string, any>;
    const content = flattenRelationalValue(
      typeof data.data === "string" ? data.data : String(data.data ?? ""),
    )[0];
    const extension = messageExtensionData(data, content);
    total += 3 + (
      Object.keys(extension).length === 0
        ? (replacingEntities ? 0 : 1)
        : countReplaceNodeStatements(extension, replacingEntities)
    );
  }
  total += (commit.messageDeletes ?? []).filter(
    (deletion) => deletion.ids.length > 0,
  ).length;

  return total;
}

export async function applySqliteCommit(
  commit: SqlCommit,
  execute: SqliteExecute,
): Promise<void> {
  const replacingEntities = commit.action === "replace-entities";
  if (commit.replaceAll) {
    await execute("DELETE FROM plugin_custom_storage");
    await execute("DELETE FROM bot_presets");
    await execute("DELETE FROM module_records");
  }
  await applyModules(commit, execute);
  await applySettingUpsert(commit, execute);
  await applySettingDeletes(commit, execute);

  if (commit.pluginStorage)
    await applyPluginStorage(commit, execute);
  
  if (commit.presets)
    await applyPresets(commit, execute);

  await applyCharacters(commit, execute, replacingEntities);
  for (const touch of commit.characterTouches ?? []) {
    await execute(
      "UPDATE characters SET last_interaction_time = ?, updated_at = datetime('now') WHERE id = ?",
      [touch.lastInteraction, touch.id],
    );
  }

  for (const id of commit.characterDeletes ?? [])
    await execute("DELETE FROM characters WHERE id = ?", [id]);

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
    const rootBranchId = `${entry.id}:root`;
    await execute(
      `INSERT OR IGNORE INTO chat_branches
          (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 'root', 0)`,
      [entry.id, rootBranchId],
    );
    await execute(
      "INSERT OR IGNORE INTO chat_active_branches (chat_id, branch_id) VALUES (?, ?)",
      [entry.id, rootBranchId],
    );
    await replaceNodes(
      execute,
      "chat_extension_nodes",
      ["chat_id"],
      [entry.id],
      data,
      replacingEntities,
    );
  }
  for (const id of commit.chatDeletes ?? [])
    await execute("DELETE FROM chats WHERE id = ?", [id]);

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
    await execute(
      `INSERT OR IGNORE INTO message_branch_links
          (chat_id, message_id, parent_message_id, origin_branch_id)
       SELECT ?, ?, branch.head_message_id, active.branch_id
         FROM chat_active_branches active
         JOIN chat_branches branch
           ON branch.chat_id = active.chat_id AND branch.id = active.branch_id
        WHERE active.chat_id = ?`,
      [entry.chatId, entry.id, entry.chatId],
    );
    await execute(
      `UPDATE chat_branches
          SET head_message_id = ?
        WHERE chat_id = ?
          AND id = (SELECT branch_id FROM chat_active_branches WHERE chat_id = ?)
          AND (head_message_id = ? OR head_message_id IS (
                SELECT parent_message_id FROM message_branch_links
                 WHERE chat_id = ? AND message_id = ?
              ))`,
      [
        entry.id,
        entry.chatId,
        entry.chatId,
        entry.id,
        entry.chatId,
        entry.id,
      ],
    );
    const extension = messageExtensionData(data, content);
    if (Object.keys(extension).length === 0) {
      if (!replacingEntities) {
        await execute(
          "DELETE FROM message_extension_nodes WHERE chat_id = ? AND message_id = ?",
          [entry.chatId, entry.id],
        );
      }
    } else {
      await replaceNodes(
        execute,
        "message_extension_nodes",
        ["chat_id", "message_id"],
        [entry.chatId, entry.id],
        extension,
        replacingEntities,
      );
    }
  }
  for (const deletion of commit.messageDeletes ?? [])
    if (deletion.ids.length) {
      await execute(
        `DELETE FROM messages WHERE chat_id = ? AND id IN (${deletion.ids.map(() => "?").join(",")})`,
        [deletion.chatId, ...deletion.ids],
      );
    }
}

async function applyCharacters(commit: SqlCommit, execute: SqliteExecute, replacingEntities: boolean) {
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
      ]
    );
    await replaceNodes(
      execute,
      "character_extension_nodes",
      ["character_id"],
      [entry.id],
      data,
      replacingEntities
    );
    await replaceCharacterTags(execute, entry.id, data.tags);
  }
}

async function applyPresets(commit: SqlCommit, execute: SqliteExecute) {
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
      ]
    );
  }
  if (commit.presets.order) {
    await execute("UPDATE bot_presets SET position = position + 1000000000");
    for (const [position, id] of commit.presets.order.entries()) {
      await execute(
        "UPDATE bot_presets SET position = ? WHERE preset_id = ?",
        [position, id]
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
      ]
    );
    await replaceNodes(
      execute,
      "setting_extension_nodes",
      ["setting_key"],
      ["activeBotPresetId"],
      value
    );
  }
}

async function applyModules(commit: SqlCommit, execute: SqliteExecute) {
  if (!commit.modules) return;

  for (const id of commit.modules.deletes) {
    await execute("DELETE FROM module_records WHERE module_id = ?", [id]);
  }
  if (commit.modules.order) {
    await execute("UPDATE module_records SET position = position + 1000000000");
  }
  for (const entry of commit.modules.upserts) {
    await execute(
      `INSERT INTO module_records (module_id, position, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(module_id) DO UPDATE SET
       position=excluded.position, updated_at=datetime('now')`,
      [entry.id, entry.position ?? 0],
    );
    await replaceNodes(
      execute,
      "module_extension_nodes",
      ["module_id"],
      [entry.id],
      entry.data,
    );
  }
  if (commit.modules.order) {
    for (const [position, id] of commit.modules.order.entries()) {
      await execute("UPDATE module_records SET position = ? WHERE module_id = ?", [
        position,
        id,
      ]);
    }
  }
}

async function applyPluginStorage(commit: SqlCommit, execute: SqliteExecute) {
  if (commit.pluginStorage.clear)
    await execute("DELETE FROM plugin_custom_storage");

  for (const key of commit.pluginStorage.deletes)
    await execute("DELETE FROM plugin_custom_storage WHERE key = ?", [key]);

  for (const upsert of commit.pluginStorage.upserts) {
    await execute(
      `INSERT INTO plugin_custom_storage (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      [upsert.key, JSON.stringify(upsert.value)]
    );
  }
}

async function applySettingDeletes(commit: SqlCommit, execute: SqliteExecute) {
  for (const key of commit.root.deletes) {
    if (key === "botPresets" || key === "botPresetsId")
      throw new Error(`${key} is not a root setting`);
    await execute("DELETE FROM system_settings WHERE key = ?", [key]);
  }
}

async function applySettingUpsert(commit: SqlCommit, execute: SqliteExecute) {
  for (const upsert of commit.root.upserts) {
    assertCanonicalRootSetting(upsert.key);
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
      ]
    );
    await replaceNodes(
      execute,
      "setting_extension_nodes",
      ["setting_key"],
      [upsert.key],
      upsert.value
    );
  }
}
