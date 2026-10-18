import * as sqliteNodes from "./nodes";
import type { SqliteSelectRows } from "../types";

interface PluginRecordRow extends Record<string, unknown> {
  plugin_id: string;
  position: number;
  name: string;
  display_name: string | null;
  api_version: string | null;
  plugin_version: string | null;
  update_url: string | null;
  enabled: number;
}

export interface Metadata {
  id: string;
  position: number;
  name: string;
  displayName?: string;
  arguments: { [key: string]: "int" | "string" | string[] };
  realArg: { [key: string]: number | string };
  version?: 1 | 2 | "2.1" | "3.0";
  customLink: { link: string; hoverText?: string }[];
  argMeta: { [key: string]: { [key: string]: string } };
  versionOfPlugin?: string;
  updateURL?: string;
  enabled?: boolean;
  allowedIPC?: string[];
}

function parseApiVersion(value: string | null): Metadata["version"] {
  switch (value) {
    case "1":
      return 1;
    case "2":
      return 2;
    case "2.1":
    case "3.0":
      return value;
    default:
      return undefined;
  }
}

function hydratePlugin(row: PluginRecordRow, extension: unknown): Metadata {
  const data =
    extension && typeof extension === "object"
      ? (extension as Partial<Metadata>)
      : {};
  return {
    arguments: {},
    realArg: {},
    customLink: [],
    argMeta: {},
    ...data,
    id: row.plugin_id,
    position: Number(row.position),
    name: row.name,
    displayName: row.display_name ?? undefined,
    version: parseApiVersion(row.api_version),
    versionOfPlugin: row.plugin_version ?? undefined,
    updateURL: row.update_url ?? undefined,
    enabled: Boolean(row.enabled),
  };
}

export async function loadAll(
  selectRows: SqliteSelectRows,
  options?: { enabledOnly?: boolean },
): Promise<Metadata[]> {
  const where = options?.enabledOnly ? "WHERE enabled = 1" : "";
  const rows = await selectRows<PluginRecordRow>(
    `SELECT plugin_id, position, name, display_name, api_version,
            plugin_version, update_url, enabled
       FROM plugin_records ${where}
      ORDER BY position`,
  );
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.plugin_id);
  const placeholders = ids.map(() => "?").join(",");
  const nodeRows = await selectRows(
    `SELECT plugin_id, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM plugin_extension_nodes
      WHERE plugin_id IN (${placeholders})
      ORDER BY plugin_id, node_id`,
    ids,
  );
  const extensions = sqliteNodes.groupValues(nodeRows, "plugin_id");
  return rows.map((row) => hydratePlugin(row, extensions.get(row.plugin_id)));
}

export async function load(
  selectRows: SqliteSelectRows,
  pluginId: string,
): Promise<Metadata | null> {
  const rows = await selectRows<PluginRecordRow>(
    `SELECT plugin_id, position, name, display_name, api_version,
            plugin_version, update_url, enabled
       FROM plugin_records
      WHERE plugin_id = ?`,
    [pluginId],
  );
  if (!rows[0]) return null;
  const nodeRows = await selectRows(
    `SELECT plugin_id, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM plugin_extension_nodes
      WHERE plugin_id = ?
      ORDER BY node_id`,
    [pluginId],
  );
  const extensions = sqliteNodes.groupValues(nodeRows, "plugin_id");
  return hydratePlugin(rows[0], extensions.get(pluginId));
}

export async function loadScript(
  selectRows: SqliteSelectRows,
  pluginId: string,
): Promise<string | null> {
  const rows = await selectRows<{ script: string }>(
    "SELECT script FROM plugin_scripts WHERE plugin_id = ?",
    [pluginId],
  );
  return rows[0]?.script ?? null;
}

export async function loadScripts(
  selectRows: SqliteSelectRows,
): Promise<Map<string, string>> {
  const rows = await selectRows<{ plugin_id: string; script: string }>(
    "SELECT plugin_id, script FROM plugin_scripts ORDER BY plugin_id",
  );
  return new Map(rows.map((row) => [row.plugin_id, row.script]));
}

// ── Plugin custom storage ────────────────────────────────────────────

export async function loadCustomStorage(
  selectRows: SqliteSelectRows,
): Promise<Record<string, unknown> | null> {
  const rows = await selectRows<{ key: string; value: string }>(
    "SELECT key, value FROM plugin_custom_storage",
  );
  if (rows.length === 0) return null;
  const storage: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      storage[row.key] = JSON.parse(row.value);
    } catch {
      storage[row.key] = row.value;
    }
  }
  return storage;
}

export async function listCustomStorageKeys(
  selectRows: SqliteSelectRows,
): Promise<string[]> {
  const rows = await selectRows<{ key: string }>(
    "SELECT key FROM plugin_custom_storage ORDER BY key",
  );
  return rows.map((row) => row.key);
}

export async function loadCustomStorageKey(
  selectRows: SqliteSelectRows,
  key: string,
): Promise<unknown> {
  const rows = await selectRows<{ value: string }>(
    "SELECT value FROM plugin_custom_storage WHERE key = ?",
    [key],
  );
  const row = rows[0];
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}
