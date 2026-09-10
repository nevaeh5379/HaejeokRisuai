import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
} from "./sqliteAdminQueries";
import { loadSqliteModules } from "./sqliteDocumentQueries";
import { loadSqlitePluginCustomStorage } from "./sqlitePersistenceQueries";
import { groupSqliteNodeValues, loadSqliteNodeValue } from "./sqliteNodeValues";
import {
  buildSqliteSettingRowsQuery,
  rebuildSqliteSettingRows,
} from "./sqliteStartupQueries";

export interface SqliteSnapshotResult {
  revision: number;
  database: Record<string, unknown> | null;
}

export interface SqliteSnapshotOptions {
  selectRows: SqliteSelectRows;
  selectRowSets: SqliteSelectRowSets;
  revision: number;
  legacyPersonaMirrorKeys: readonly string[];
  loadChatMessages(chatId: string): Promise<unknown[]>;
}

interface CharacterRow extends Record<string, unknown> {
  id: string;
  position: number;
  kind: string;
  name: string;
  image: string | null;
  trash_time: number | null;
  creation_time: number | null;
  modification_time: number | null;
  last_interaction_time: number | null;
  details_loaded: number;
}

interface ChatRow extends Record<string, unknown> {
  id: string;
  name: string;
  note: string;
  folder_id: string | null;
  last_message_time: number | null;
}

interface SnapshotChat extends Record<string, unknown> {
  id: string;
  message: unknown[];
}

interface SnapshotCharacter extends Record<string, unknown> {
  chaId: string;
  type: "character" | "group";
  chats: SnapshotChat[];
}

async function loadSnapshotChats(
  selectRows: SqliteSelectRows,
  characterId: string,
  loadChatMessages: SqliteSnapshotOptions["loadChatMessages"],
): Promise<SnapshotChat[]> {
  const chatRows = await selectRows<ChatRow>(
    "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
    [characterId],
  );
  const nodeRows = chatRows.length
    ? await selectRows(
        `SELECT chat_id, node_id, parent_node_id, node_order, object_key,
                object_key_encoded, value_type, text_value, encoded_text_value,
                number_value, boolean_value
           FROM chat_extension_nodes
          WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)
          ORDER BY chat_id, node_id`,
        [characterId],
      )
    : [];
  const values = groupSqliteNodeValues(nodeRows, "chat_id");
  const chats: SnapshotChat[] = [];
  for (const row of chatRows) {
    const chat = {
      ...((values.get(row.id) as Record<string, unknown> | undefined) ?? {}),
      id: row.id,
      name: row.name ?? "",
      note: row.note ?? "",
      folderId: row.folder_id ?? undefined,
      lastDate: row.last_message_time ?? undefined,
      message: await loadChatMessages(row.id),
      messageOffset: 0,
      messagesLoaded: true,
      messagesFullyLoaded: true,
      detailsLoaded: true,
    } as SnapshotChat;
    chat.messageTotal = chat.message.length;
    chats.push(chat);
  }
  return chats;
}

async function loadSnapshotCharacter(
  selectRows: SqliteSelectRows,
  row: CharacterRow,
  loadChatMessages: SqliteSnapshotOptions["loadChatMessages"],
): Promise<SnapshotCharacter> {
  const extension =
    ((await loadSqliteNodeValue(
      selectRows,
      "character_extension_nodes",
      "character_id = ?",
      [row.id],
    )) as Record<string, unknown> | undefined) ?? {};
  const type = row.kind === "group" ? "group" : "character";
  const character = {
    ...extension,
    chaId: row.id,
    name: row.name ?? String(extension.name ?? ""),
    type,
    image: row.image ?? String(extension.image ?? ""),
    trashTime: row.trash_time ?? extension.trashTime,
    lastInteraction: row.last_interaction_time ?? extension.lastInteraction,
    detailsLoaded: true,
    chats: await loadSnapshotChats(selectRows, row.id, loadChatMessages),
  } as SnapshotCharacter;
  if (type === "character") {
    character.creation_date = row.creation_time ?? extension.creation_date;
    character.modification_date =
      row.modification_time ?? extension.modification_date;
  }
  return character;
}

function parsePresetRows(rows: Array<{ preset_id: string; data: string }>): {
  ids: string[];
  presets: Record<string, unknown>[];
} {
  const ids = rows.map((row) => row.preset_id);
  const presets: Record<string, unknown>[] = [];
  for (const row of rows) {
    try {
      const preset = JSON.parse(row.data) as Record<string, unknown>;
      presets.push(preset);
    } catch {
      // Ignore malformed legacy preset payloads, matching the old adapters.
    }
  }
  return { ids, presets };
}

export async function exportSqliteDatabaseSnapshot(
  options: SqliteSnapshotOptions,
): Promise<SqliteSnapshotResult> {
  const {
    selectRows,
    selectRowSets,
    revision,
    legacyPersonaMirrorKeys,
    loadChatMessages,
  } = options;
  const settingQuery = buildSqliteSettingRowsQuery(legacyPersonaMirrorKeys);
  const [settingRows, characterRows, metaRows] = await selectRowSets([
    settingQuery,
    {
      sql: "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
      bind: [],
    },
    {
      sql: "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
      bind: [],
    },
  ]);
  const settings = rebuildSqliteSettingRows(
    settingRows,
    legacyPersonaMirrorKeys,
  );
  const database = Object.fromEntries(settings.values) as Record<
    string,
    unknown
  >;

  database.pluginCustomStorage =
    (await loadSqlitePluginCustomStorage(selectRows)) ?? {};
  const characters: SnapshotCharacter[] = [];
  for (const row of characterRows as unknown as CharacterRow[]) {
    characters.push(
      await loadSnapshotCharacter(selectRows, row, loadChatMessages),
    );
  }
  database.characters = characters;
  database.modules =
    await loadSqliteModules<Record<string, unknown>>(selectRows);

  const presetRows = await selectRows<{
    preset_id: string;
    data: string;
  }>("SELECT preset_id, data FROM bot_presets ORDER BY position");
  const { ids: presetIds, presets } = parsePresetRows(presetRows);
  database.botPresets = presets;
  const activePresetId = database.activeBotPresetId;
  database.botPresetsId =
    typeof activePresetId === "string"
      ? Math.max(0, presetIds.indexOf(activePresetId))
      : 0;

  const initialized =
    Number(metaRows[0]?.initialized) === 1 ||
    characters.length > 0 ||
    settings.keyCount > 0 ||
    (database.modules as unknown[]).length > 0 ||
    presets.length > 0;
  return {
    revision,
    database: initialized ? database : null,
  };
}
