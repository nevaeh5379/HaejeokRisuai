import * as nodeCodec from "../schema/codec";

// ── Shared settings-load SQL (used by web / tauri / capacitor backends) ──

export type NodeRow = {
  setting_key: string;
  node_id: number | null;
  parent_node_id: number | null;
  node_order: number | null;
  object_key: string | null;
  object_key_encoded: string | null;
  value_type: string | null;
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
};

export const NODE_COLUMNS = `setting_key, node_id, parent_node_id, node_order,
        object_key, object_key_encoded, value_type, text_value, encoded_text_value,
        number_value, boolean_value`;

export function buildDeferredQuery(deferredKeyList: readonly string[]): {
  sql: string;
  bind: string[];
} {
  const deferredWhere = deferredKeyList.length
    ? ` WHERE setting_key NOT IN (${deferredKeyList.map(() => "?").join(",")})`
    : "";
  return {
    sql: `SELECT setting_key, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
     FROM setting_extension_nodes${deferredWhere}
     ORDER BY setting_key, node_id`,
    bind: [...deferredKeyList],
  };
}

export function groupNodeRows(rows: NodeRow[]): Map<string, unknown> {
  const grouped = new Map<string, nodeCodec.NodeRow[]>();
  for (const row of rows) {
    const owner = String(row.setting_key ?? "");
    if (!owner) continue;
    const list = grouped.get(owner) ?? [];
    list.push(row as nodeCodec.NodeRow);
    grouped.set(owner, list);
  }
  return new Map(
    Array.from(grouped, ([owner, nodes]) => [owner, nodeCodec.rebuild(nodes)]),
  );
}
