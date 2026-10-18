import * as nodeCodec from "../schema/codec";
import type { SqliteSelectRows } from "../types";

export const COLUMNS_SQL = `node_id, parent_node_id, node_order, object_key,
  object_key_encoded, value_type, text_value, encoded_text_value, number_value,
  boolean_value`;

export async function loadValue(
  selectRows: SqliteSelectRows,
  table: string,
  ownerWhere: string,
  bind: unknown[],
): Promise<unknown> {
  const rows = await selectRows(
    `SELECT ${COLUMNS_SQL} FROM ${table} WHERE ${ownerWhere} ORDER BY node_id`,
    bind,
  );
  return rows.length > 0 ? nodeCodec.rebuild(rows) : undefined;
}

export function loadSettingValue(
  selectRows: SqliteSelectRows,
  key: string,
): Promise<unknown> {
  return loadValue(selectRows, "setting_extension_nodes", "setting_key = ?", [
    key,
  ]);
}

export function groupValues(
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
    Array.from(grouped, ([owner, nodes]) => [owner, nodeCodec.rebuild(nodes)]),
  );
}
