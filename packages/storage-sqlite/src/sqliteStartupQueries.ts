import { decodedText, rebuildRelationalValue } from "./relationalNodeCodec";
import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
} from "./sqliteAdminQueries";
import type { SqliteTransactionStatement } from "./sqliteQueries";

export const SQLITE_STARTUP_SETTING_TEXT_LIMIT = 256 * 1024;

export interface SqliteStartupCharacter {
  id: string;
  kind: "character" | "group";
  name: string;
  image: string;
  trashTime?: number;
  creationDate?: number;
  modificationDate?: number;
  lastInteraction?: number;
}

export interface SqliteStartupProjection {
  status: "ready" | "empty";
  revision: number;
  settings: Map<string, unknown>;
  characters: SqliteStartupCharacter[];
  deferredSettingKeys: string[];
}

export function buildSqliteSettingRowsQuery(
  deferredKeyList: readonly string[] = [],
  shallow = false,
): SqliteTransactionStatement {
  const limit = SQLITE_STARTUP_SETTING_TEXT_LIMIT;
  const project = (column: string) =>
    shallow
      ? `CASE WHEN length(n.${column}) > ${limit} THEN NULL ELSE n.${column} END`
      : `n.${column}`;
  const oversizedMarker = shallow
    ? `CASE WHEN length(n.text_value) > ${limit}
              OR length(n.encoded_text_value) > ${limit}
              OR length(n.object_key) > ${limit}
              OR length(n.object_key_encoded) > ${limit}
         THEN 1 ELSE 0 END AS startup_oversized,`
    : "";
  return {
    sql: `SELECT s.key AS setting_key, s.domain AS setting_domain, s.value_type AS setting_value_type,
            s.text_value AS setting_text_value, s.encoded_text_value AS setting_encoded_text_value,
            s.number_value AS setting_number_value, s.boolean_value AS setting_boolean_value,
            n.node_id, n.parent_node_id, n.node_order,
            ${project("object_key")} AS object_key,
            ${project("object_key_encoded")} AS object_key_encoded,
            n.value_type, ${project("text_value")} AS text_value,
            ${project("encoded_text_value")} AS encoded_text_value,
            n.number_value, n.boolean_value,
            ${oversizedMarker}
            0 AS startup_projection
       FROM system_settings s
       LEFT JOIN setting_extension_nodes n ON n.setting_key = s.key${
         deferredKeyList.length
           ? ` AND s.key NOT IN (${deferredKeyList.map(() => "?").join(",")})`
           : ""
       }
       ORDER BY s.key, n.node_id`,
    bind: [...deferredKeyList],
  };
}

export function rebuildSqliteSettingRows(
  rows: readonly Record<string, unknown>[],
  deferredKeyList: readonly string[] = [],
): {
  values: Map<string, unknown>;
  keyCount: number;
  deferredKeys: Set<string>;
} {
  const deferredKeys = new Set(deferredKeyList);
  const grouped = new Map<string, Record<string, unknown>[]>();
  const rootRows = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row.setting_key ?? "");
    if (!key) continue;
    if (!rootRows.has(key)) rootRows.set(key, row);
    if (Number(row.startup_oversized) === 1) deferredKeys.add(key);
    const nodes = grouped.get(key) ?? [];
    if (row.node_id !== null && row.node_id !== undefined) nodes.push(row);
    grouped.set(key, nodes);
  }
  const values = new Map<string, unknown>();
  for (const [key, nodes] of grouped) {
    if (deferredKeys.has(key)) continue;
    if (nodes.length > 0) {
      values.set(key, rebuildRelationalValue(nodes));
      continue;
    }
    const root = rootRows.get(key);
    const valueType = root?.setting_value_type ?? root?.value_type;
    switch (valueType) {
      case "string":
        values.set(
          key,
          decodedText(
            root?.setting_text_value ?? root?.text_value,
            root?.setting_encoded_text_value ?? root?.encoded_text_value,
          ),
        );
        break;
      case "number":
        values.set(
          key,
          Number(root?.setting_number_value ?? root?.number_value),
        );
        break;
      case "boolean":
        values.set(
          key,
          Boolean(root?.setting_boolean_value ?? root?.boolean_value),
        );
        break;
      case "null":
        values.set(key, null);
        break;
      default:
        values.set(key, undefined);
        break;
    }
  }
  return { values, keyCount: grouped.size, deferredKeys };
}

export async function loadSqliteStartupProjection(
  selectRowSets: SqliteSelectRowSets,
  revision: number,
  deferredSettingKeys: readonly string[],
  excludedSettingKeys: readonly string[],
): Promise<SqliteStartupProjection> {
  const excludedKeys = [
    ...new Set([...deferredSettingKeys, ...excludedSettingKeys]),
  ];
  const queries: SqliteTransactionStatement[] = [
    buildSqliteSettingRowsQuery(excludedKeys, true),
    {
      sql: "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
      bind: [],
    },
    {
      sql: "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
      bind: [],
    },
  ];
  const [settingRows, characterRows, metaRows] = await selectRowSets(queries);
  const rebuilt = rebuildSqliteSettingRows(settingRows, excludedKeys);
  const excluded = new Set(excludedSettingKeys);
  const settings = new Map(
    [...rebuilt.values].filter(([key]) => !excluded.has(key)),
  );
  const characters = characterRows.map((row) => ({
    id: String(row.id ?? ""),
    kind: row.kind === "group" ? ("group" as const) : ("character" as const),
    name: String(row.name ?? ""),
    image: String(row.image ?? ""),
    trashTime: row.trash_time == null ? undefined : Number(row.trash_time),
    creationDate:
      row.creation_time == null ? undefined : Number(row.creation_time),
    modificationDate:
      row.modification_time == null ? undefined : Number(row.modification_time),
    lastInteraction:
      row.last_interaction_time == null
        ? undefined
        : Number(row.last_interaction_time),
  }));
  const initialized =
    Number(metaRows[0]?.initialized) === 1 ||
    characters.length > 0 ||
    rebuilt.keyCount > 0;
  return {
    status: initialized ? "ready" : "empty",
    revision,
    settings,
    characters,
    deferredSettingKeys: [...rebuilt.deferredKeys].filter(
      (key) => !excluded.has(key),
    ),
  };
}

export async function getSqliteStorageSyncSummary(
  selectRows: SqliteSelectRows,
  fallbackRevision: number,
) {
  const rows = await selectRows<{
    revision: number;
    initialized: number | boolean;
    settings_count: number;
    characters_count: number;
    chats_count: number;
    messages_count: number;
  }>(`SELECT revision, initialized,
            (SELECT COUNT(*) FROM system_settings) AS settings_count,
            (SELECT COUNT(*) FROM characters) AS characters_count,
            (SELECT COUNT(*) FROM chats) AS chats_count,
            (SELECT COUNT(*) FROM messages) AS messages_count
       FROM system_storage_meta WHERE singleton = 1`);
  const row = rows[0];
  const records = {
    settings: Number(row?.settings_count) || 0,
    characters: Number(row?.characters_count) || 0,
    chats: Number(row?.chats_count) || 0,
    messages: Number(row?.messages_count) || 0,
  };
  return {
    revision: Number.isSafeInteger(Number(row?.revision))
      ? Number(row?.revision)
      : fallbackRevision,
    initialized: row?.initialized === true || Number(row?.initialized) === 1,
    records: {
      ...records,
      total: Object.values(records).reduce((sum, value) => sum + value, 0),
    },
  };
}
