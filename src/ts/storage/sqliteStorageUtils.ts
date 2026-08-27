export interface SqliteTransactionStatement {
  sql: string;
  bind: unknown[];
}

import {
  rebuildRelationalValue,
  type RelationalNodeRow,
} from "./relationalNodeCodec";
import type { Message } from "./database.svelte";

export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeSqliteLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

export function normalizeSqlitePageEnd(
  before: number | undefined,
  total: number,
): number {
  if (before === undefined || !Number.isFinite(before)) return total;
  return Math.min(total, Math.max(0, Math.floor(before)));
}

// ── Shared settings-load SQL (used by web / tauri / capacitor backends) ──

export type SettingNodeRow = {
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

export const SETTING_NODE_COLUMNS = `setting_key, node_id, parent_node_id, node_order,
        object_key, object_key_encoded, value_type, text_value, encoded_text_value,
        number_value, boolean_value`;

export function buildDeferredSettingsQuery(
  deferredKeyList: readonly string[],
): { sql: string; bind: string[] } {
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

export function groupSettingNodeRows(
  rows: SettingNodeRow[],
): Map<string, unknown> {
  const grouped = new Map<string, RelationalNodeRow[]>();
  for (const row of rows) {
    const owner = String(row.setting_key ?? "");
    if (!owner) continue;
    const list = grouped.get(owner) ?? [];
    list.push(row as RelationalNodeRow);
    grouped.set(owner, list);
  }
  return new Map(
    Array.from(grouped, ([owner, nodes]) => [
      owner,
      rebuildRelationalValue(nodes),
    ]),
  );
}

/**
 * Rebuilds Message objects from the batched message-row join (see
 * buildMessageRowsQuery). Mirrors the worker-side rebuild used by the web
 * backend so all backends produce identical message objects.
 */
export function rebuildMessageRows(
  rows: Record<string, unknown>[],
): Message[] {
  const nodeGroups = new Map<string, RelationalNodeRow[]>();
  const coreRows = new Map<string, Record<string, unknown>>();
  const orderedIds: string[] = [];
  for (const row of rows) {
    const id = String(row.message_id);
    if (!coreRows.has(id)) {
      coreRows.set(id, row);
      orderedIds.push(id);
    }
    if (row.node_id === null || row.node_id === undefined) continue;
    const nodes = nodeGroups.get(id) ?? [];
    nodes.push(row as RelationalNodeRow);
    nodeGroups.set(id, nodes);
  }
  return orderedIds.map((id) => {
    const core = coreRows.get(id)!;
    const nodes = nodeGroups.get(id);
    const rebuilt = nodes?.length
      ? rebuildRelationalValue(nodes)
      : {
          role: String(core.message_role ?? "char"),
          data: String(core.message_content_text ?? ""),
          ...(core.message_sender_name != null
            ? { name: String(core.message_sender_name) }
            : {}),
          ...(core.message_sent_time != null
            ? { time: Number(core.message_sent_time) }
            : {}),
        };
    const message =
      rebuilt && typeof rebuilt === "object"
        ? (rebuilt as Message)
        : ({ role: "char", data: String(rebuilt ?? "") } as Message);
    message.chatId = id;
    // In generation mode the generationInfo subtree is stripped, but the
    // core messages row still carries the model/token columns — restore
    // them so token accounting keeps working without the full metadata.
    if (core.message_generation_model != null) {
      message.generationInfo ??= {};
      message.generationInfo.model = String(core.message_generation_model);
      if (core.message_input_tokens != null) {
        message.generationInfo.inputTokens = Number(core.message_input_tokens);
      }
      if (core.message_output_tokens != null) {
        message.generationInfo.outputTokens = Number(
          core.message_output_tokens,
        );
      }
    }
    return message;
  });
}

// ── Character asset-field query (storage analyzer) ───────────────────

export const CHARACTER_ASSET_FIELD_KEYS = [
  "image",
  "emotionImages",
  "emotions",
  "additionalAssets",
  "ccAssets",
  "customBackground",
  "gptSoVitsConfig",
  "vits",
] as const;

/**
 * Builds a query that reads only the asset-bearing root subtrees of a
 * character's extension-node tree. Node ids are dense preorder indices, so
 * every subtree rooted at one of the asset field keys is exactly the set of
 * nodes in [node_id, next_root_node_id) sharing the same root — the recursive
 * CTE collects descendants from the selected roots and the outer WHERE
 * excludes everything else.
 */
export function buildCharacterAssetFieldsQuery(characterId: string): {
  sql: string;
  bind: string[];
} {
  const placeholders = CHARACTER_ASSET_FIELD_KEYS.map(() => "?").join(",");
  return {
    sql: `WITH RECURSIVE asset_nodes(chat_id, node_id) AS (
       SELECT character_id, node_id FROM character_extension_nodes
        WHERE character_id = ? AND parent_node_id = 0
          AND object_key IN (${placeholders})
       UNION ALL
       SELECT child.character_id, child.node_id
         FROM character_extension_nodes child
         JOIN asset_nodes ON child.character_id = asset_nodes.chat_id
            AND child.parent_node_id = asset_nodes.node_id
     )
     SELECT node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM character_extension_nodes
      WHERE character_id = ?
        AND (node_id = 0 OR node_id IN (SELECT node_id FROM asset_nodes))
      ORDER BY node_id`,
    bind: [
      characterId,
      ...CHARACTER_ASSET_FIELD_KEYS,
      characterId,
    ],
  };
}

// ── Shared message batch query (web / tauri / capacitor) ─────────────

export type MessageLoadMode = "full" | "generation";

/**
 * Builds the batched message read: one query that joins message core rows
 * with their extension nodes so a whole chat hydrates without per-message
 * round trips.
 *
 * In "generation" mode, the promptInfo/generationInfo metadata subtrees are
 * excluded via a recursive CTE over plaintext root object keys. Generation
 * only needs the message body — the stored prompt text can be hundreds of KB
 * per message and is not needed to append a new reply (same trade-off as the
 * nodePostgres backend's ?mode=generation).
 */
export function buildMessageRowsQuery(
  chatId: string,
  limit: number | undefined,
  offset: number,
  newest: boolean,
  mode: MessageLoadMode = "full",
): { sql: string; bind: unknown[] } {
  let selectedSql =
    "SELECT chat_id, id, position, role, content_text, sender_name, sent_time, generation_model, input_tokens, output_tokens FROM messages WHERE chat_id = ?";
  const bind: unknown[] = [chatId];
  if (limit === undefined) {
    selectedSql += " ORDER BY position";
  } else if (newest) {
    selectedSql = `SELECT * FROM (${selectedSql} ORDER BY position DESC LIMIT ?) ORDER BY position`;
    bind.push(limit);
  } else {
    selectedSql += " ORDER BY position LIMIT ? OFFSET ?";
    bind.push(limit, offset);
  }

  // Excluded subtrees: every node descending from a root child whose
  // object_key names a metadata field. node ids are dense preorder indices,
  // so "descendant" can be computed with the (chat_id, message_id, node_id)
  // key plus a recursive CTE walking parent links.
  const metadataFilter =
    mode === "generation"
      ? ` WHERE n.node_id IS NULL OR n.node_id = 0 OR n.node_id NOT IN (
     WITH RECURSIVE excluded(chat_id, message_id, node_id) AS (
       SELECT chat_id, message_id, node_id
         FROM message_extension_nodes
        WHERE chat_id = ?
          AND parent_node_id = 0
          AND object_key IN ('promptInfo', 'generationInfo')
       UNION ALL
       SELECT child.chat_id, child.message_id, child.node_id
         FROM message_extension_nodes child
         JOIN excluded ON child.chat_id = excluded.chat_id
            AND child.message_id = excluded.message_id
            AND child.parent_node_id = excluded.node_id
     )
     SELECT node_id FROM excluded WHERE chat_id = ?
   )`
      : "";
  const metadataBind = mode === "generation" ? [chatId, chatId] : [];

  return {
    sql: `WITH selected AS (${selectedSql})
   SELECT selected.id AS message_id, selected.position AS message_position,
          selected.role AS message_role, selected.content_text AS message_content_text,
          selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
          selected.generation_model AS message_generation_model,
          selected.input_tokens AS message_input_tokens,
          selected.output_tokens AS message_output_tokens,
          n.node_id, n.parent_node_id, n.node_order, n.object_key,
          n.object_key_encoded, n.value_type, n.text_value, n.encoded_text_value,
          n.number_value, n.boolean_value
   FROM selected
   LEFT JOIN message_extension_nodes n
     ON n.chat_id = selected.chat_id AND n.message_id = selected.id${metadataFilter}
   ORDER BY selected.position, n.node_id`,
    bind: [...bind, ...metadataBind],
  };
}
