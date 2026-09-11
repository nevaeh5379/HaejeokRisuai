import type { SqliteSelectRows } from "./sqliteAdminQueries";
import {
  groupSqliteNodeValues,
  loadSqliteSettingValue,
} from "./sqliteNodeValues";

export interface SqliteBotPresetSummary {
  id: string;
  position: number;
  name: string;
  image: string;
  apiType: string;
  aiModel: string;
  hash: string;
}

export async function loadSqliteSettingValues(
  selectRows: SqliteSelectRows,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  if (keys.length === 0) return new Map();
  const rows = await selectRows(
    `SELECT setting_key, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM setting_extension_nodes
      WHERE setting_key IN (${keys.map(() => "?").join(",")})
      ORDER BY setting_key, node_id`,
    [...keys],
  );
  const grouped = groupSqliteNodeValues(rows, "setting_key");
  return new Map(keys.map((key) => [key, grouped.get(key)]));
}

export async function listSqliteSettingKeys(
  selectRows: SqliteSelectRows,
): Promise<string[]> {
  const rows = await selectRows<{ key: string }>(
    "SELECT key FROM system_settings ORDER BY key",
  );
  return rows.map((row) => row.key);
}

export async function listSqliteBotPresets(
  selectRows: SqliteSelectRows,
): Promise<SqliteBotPresetSummary[]> {
  const rows = await selectRows<{
    preset_id: string;
    position: number;
    name: string;
    image: string;
    api_type: string;
    ai_model: string;
    content_hash: string;
  }>(
    "SELECT preset_id, position, name, image, api_type, ai_model, content_hash FROM bot_presets ORDER BY position",
  );
  return rows.map((row) => ({
    id: row.preset_id,
    position: Number(row.position),
    name: row.name,
    image: row.image,
    apiType: row.api_type,
    aiModel: row.ai_model,
    hash: row.content_hash,
  }));
}

export async function loadSqliteBotPreset<TPreset extends object>(
  selectRows: SqliteSelectRows,
  id: string,
): Promise<(TPreset & { id: string }) | null> {
  const rows = await selectRows<{ data: string }>(
    "SELECT data FROM bot_presets WHERE preset_id = ?",
    [id],
  );
  if (!rows[0]) return null;
  return { ...(JSON.parse(rows[0].data) as TPreset), id };
}

export async function loadSqliteModules<TModule extends object>(
  selectRows: SqliteSelectRows,
): Promise<TModule[]> {
  const rows = await selectRows<{ module_id: string }>(
    "SELECT module_id FROM module_records ORDER BY position",
  );
  if (rows.length === 0) {
    return (
      ((await loadSqliteSettingValue(selectRows, "modules")) as
        TModule[] | undefined) ?? []
    );
  }
  const nodeRows = await selectRows(
    `SELECT module_id, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM module_extension_nodes
      ORDER BY module_id, node_id`,
  );
  const values = groupSqliteNodeValues(nodeRows, "module_id");
  return rows.map(({ module_id }) => ({
    ...(values.get(module_id) as TModule),
    id: module_id,
  }));
}

export async function loadSqlitePrompts(
  selectRows: SqliteSelectRows,
): Promise<Record<string, unknown>> {
  const keys = await selectRows<{ key: string }>(
    "SELECT key FROM system_settings WHERE domain = 'prompt' ORDER BY key",
  );
  if (keys.length === 0) return {};
  const nodeRows = await selectRows(
    `SELECT setting_key, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM setting_extension_nodes
      WHERE setting_key IN (SELECT key FROM system_settings WHERE domain = 'prompt')
      ORDER BY setting_key, node_id`,
  );
  const values = groupSqliteNodeValues(nodeRows, "setting_key");
  return Object.fromEntries(keys.map(({ key }) => [key, values.get(key)]));
}
