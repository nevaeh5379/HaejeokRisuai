import { rebuildRelationalValue } from "./relationalNodeCodec";
import type { SqliteSelectRows } from "./sqliteAdminQueries";

export const SQLITE_RELATIONAL_NODE_COLUMNS = `node_id, parent_node_id, node_order, object_key,
  object_key_encoded, value_type, text_value, encoded_text_value, number_value,
  boolean_value`;

export async function loadSqliteNodeValue(
  selectRows: SqliteSelectRows,
  table: string,
  ownerWhere: string,
  bind: unknown[],
): Promise<unknown> {
  const rows = await selectRows(
    `SELECT ${SQLITE_RELATIONAL_NODE_COLUMNS} FROM ${table} WHERE ${ownerWhere} ORDER BY node_id`,
    bind,
  );
  return rows.length > 0 ? rebuildRelationalValue(rows) : undefined;
}

export function loadSqliteSettingValue(
  selectRows: SqliteSelectRows,
  key: string,
): Promise<unknown> {
  return loadSqliteNodeValue(
    selectRows,
    "setting_extension_nodes",
    "setting_key = ?",
    [key],
  );
}

export function groupSqliteNodeValues(
  rows: readonly Record<string, unknown>[],
  ownerKey: string,
): Map<string, unknown> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const owner = String(row[ownerKey] ?? "");
    if (!owner) continue;
    const list = grouped.get(owner) ?? [];
    list.push(row);
    grouped.set(owner, list);
  }
  return new Map(
    Array.from(grouped, ([owner, nodes]) => [
      owner,
      rebuildRelationalValue(nodes),
    ]),
  );
}
