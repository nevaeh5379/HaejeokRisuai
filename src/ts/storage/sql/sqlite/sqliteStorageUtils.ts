export interface SqliteTransactionStatement {
  sql: string;
  bind: unknown[];
}

import {
  rebuildRelationalValue,
  decodedText,
  type RelationalNodeRow,
} from "./relationalNodeCodec";
import type { Message } from "../../database/schema";

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
    const rebuilt = nodes?.length ? rebuildRelationalValue(nodes) : {};
    const message =
      rebuilt && typeof rebuilt === "object"
        ? (rebuilt as Message)
        : ({} as Message);

    // Core columns are authoritative. Newer writes omit these duplicated
    // fields from message_extension_nodes; older databases that still contain
    // them remain readable because the core values simply replace the copies.
    message.role = String(core.message_role ?? "char") as Message["role"];
    if (!Object.prototype.hasOwnProperty.call(message, "data")) {
      message.data = decodedText(
        core.message_content_text as string | null,
        core.message_content_encoded as string | null,
      );
    }
    if (core.message_sender_name != null) {
      message.name = String(core.message_sender_name);
    } else {
      delete message.name;
    }
    if (core.message_sent_time != null) {
      message.time = Number(core.message_sent_time);
    } else {
      delete message.time;
    }
    message.chatId = id;

    if (
      core.message_generation_model != null ||
      core.message_input_tokens != null ||
      core.message_output_tokens != null
    ) {
      message.generationInfo ??= {};
      if (core.message_generation_model != null) {
        message.generationInfo.model = String(core.message_generation_model);
      }
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
  "snapshotAssetRefs",
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

export type MessageLoadMode = "full" | "generation" | "graph";

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
    "SELECT chat_id, id, position, role, content_text, content_encoded, sender_name, sent_time, generation_model, input_tokens, output_tokens FROM messages WHERE chat_id = ?";
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

  const withExcluded =
    mode === "generation"
      ? `,
excluded(chat_id, message_id, node_id) AS (
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
)`
      : "";

  const metadataFilter =
    mode === "generation"
      ? ` WHERE n.node_id IS NULL OR n.node_id = 0 OR NOT EXISTS (
     SELECT 1 FROM excluded
      WHERE excluded.message_id = n.message_id
        AND excluded.node_id = n.node_id
   )`
      : "";
  const metadataBind = mode === "generation" ? [chatId] : [];
  const extensionJoin = mode === "graph"
    ? "LEFT JOIN message_extension_nodes n ON 0"
    : "LEFT JOIN message_extension_nodes n ON n.chat_id = selected.chat_id AND n.message_id = selected.id";

  return {
    sql: `WITH selected AS (${selectedSql})${withExcluded}
   SELECT selected.id AS message_id, selected.position AS message_position,
          selected.role AS message_role, selected.content_text AS message_content_text,
          selected.content_encoded AS message_content_encoded,
          selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
          selected.generation_model AS message_generation_model,
          selected.input_tokens AS message_input_tokens,
          selected.output_tokens AS message_output_tokens,
          n.node_id, n.parent_node_id, n.node_order, n.object_key,
          n.object_key_encoded, n.value_type, n.text_value, n.encoded_text_value,
          n.number_value, n.boolean_value
   FROM selected
   ${extensionJoin}${metadataFilter}
   ORDER BY selected.position, n.node_id`,
    bind: [...bind, ...metadataBind],
  };
}

export function rebuildBranchGraphMessages(
  rows: Record<string, unknown>[],
): Message[] {
  const comments = new Map<string, boolean>();
  for (const row of rows) {
    if (row.graph_is_comment == null) continue;
    comments.set(String(row.message_id), Boolean(row.graph_is_comment));
  }
  const messages = rebuildMessageRows(rows);
  for (const message of messages) {
    if (message.chatId && comments.has(message.chatId)) {
      message.isComment = comments.get(message.chatId)!;
    }
  }
  return messages;
}

/** Lightweight unique-message read used by the branch graph modal. */
export function buildBranchGraphRowsQuery(chatId: string): { sql: string; bind: unknown[] } {
  return {
    sql: `SELECT messages.id AS message_id, messages.position AS message_position,
                 messages.role AS message_role, messages.content_text AS message_content_text,
                 messages.content_encoded AS message_content_encoded,
                 messages.sender_name AS message_sender_name, messages.sent_time AS message_sent_time,
                 messages.generation_model AS message_generation_model,
                 messages.input_tokens AS message_input_tokens,
                 messages.output_tokens AS message_output_tokens,
                 comment_node.boolean_value AS graph_is_comment,
                 links.parent_message_id AS graph_parent_message_id,
                 links.origin_branch_id AS graph_origin_branch_id
            FROM message_branch_links links
            JOIN messages
              ON messages.chat_id = links.chat_id AND messages.id = links.message_id
       LEFT JOIN message_extension_nodes comment_node
              ON comment_node.chat_id = messages.chat_id
             AND comment_node.message_id = messages.id
             AND comment_node.parent_node_id = 0
             AND comment_node.object_key = 'isComment'
           WHERE links.chat_id = ?
        ORDER BY messages.position, messages.id`,
    bind: [chatId],
  };
}

/**
 * Reads one persisted branch by walking from its head to the root. Unlike the
 * legacy position query this never touches messages that belong only to an
 * inactive branch.
 */
export function buildBranchMessageRowsQuery(
  chatId: string,
  branchId: string | undefined,
  limit: number | undefined,
  mode: MessageLoadMode = "full",
  rootOffset?: number,
): { sql: string; bind: unknown[] } {
  const recursionLimit =
    limit === undefined || rootOffset !== undefined
      ? ""
      : " AND path.depth + 1 < ?";
  const branchSeed = branchId === undefined
    ? `SELECT branch.head_message_id, 0
         FROM chat_branches branch
         JOIN chat_active_branches active
           ON active.chat_id = branch.chat_id AND active.branch_id = branch.id
        WHERE branch.chat_id = ?`
    : `SELECT head_message_id, 0
         FROM chat_branches
        WHERE chat_id = ? AND id = ?`;
  const bind: unknown[] = branchId === undefined
    ? [chatId, chatId]
    : [chatId, branchId, chatId];
  if (limit !== undefined && rootOffset === undefined) bind.push(limit);
  const selectedPage =
    limit !== undefined && rootOffset !== undefined
      ? " ORDER BY branch_path.depth DESC LIMIT ? OFFSET ?"
      : "";

  if (mode === "graph") {
    return {
      sql: `WITH RECURSIVE branch_path(message_id, depth) AS (
  ${branchSeed}
  UNION ALL
  SELECT links.parent_message_id, path.depth + 1
    FROM branch_path path
    JOIN message_branch_links links
      ON links.chat_id = ? AND links.message_id = path.message_id
   WHERE links.parent_message_id IS NOT NULL${recursionLimit}
),
selected AS (
  SELECT messages.*, branch_path.depth
    FROM branch_path
    JOIN messages
      ON messages.chat_id = ? AND messages.id = branch_path.message_id
   ${selectedPage}
)
SELECT selected.id AS message_id, selected.position AS message_position,
       selected.role AS message_role, selected.content_text AS message_content_text,
       selected.content_encoded AS message_content_encoded,
       selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
       selected.generation_model AS message_generation_model,
       selected.input_tokens AS message_input_tokens,
       selected.output_tokens AS message_output_tokens
  FROM selected
 ORDER BY selected.depth DESC`,
      bind: [
        ...bind,
        chatId,
        ...(selectedPage ? [limit, rootOffset] : []),
      ],
    };
  }

  const withExcluded =
    mode === "generation"
      ? `,
excluded(chat_id, message_id, node_id) AS (
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
)`
      : "";
  const metadataFilter =
    mode === "generation"
      ? ` WHERE n.node_id IS NULL OR n.node_id = 0 OR NOT EXISTS (
     SELECT 1 FROM excluded
      WHERE excluded.message_id = n.message_id
        AND excluded.node_id = n.node_id
   )`
      : "";
  const extensionJoin = "LEFT JOIN message_extension_nodes n ON n.chat_id = selected.chat_id AND n.message_id = selected.id";
  return {
    sql: `WITH RECURSIVE branch_path(message_id, depth) AS (
  ${branchSeed}
  UNION ALL
  SELECT links.parent_message_id, path.depth + 1
    FROM branch_path path
    JOIN message_branch_links links
      ON links.chat_id = ? AND links.message_id = path.message_id
   WHERE links.parent_message_id IS NOT NULL${recursionLimit}
),
selected AS (
  SELECT messages.*, branch_path.depth
    FROM branch_path
    JOIN messages
      ON messages.chat_id = ? AND messages.id = branch_path.message_id
   ${selectedPage}
)${withExcluded}
   SELECT selected.id AS message_id, selected.position AS message_position,
          selected.role AS message_role, selected.content_text AS message_content_text,
          selected.content_encoded AS message_content_encoded,
          selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
          selected.generation_model AS message_generation_model,
          selected.input_tokens AS message_input_tokens,
          selected.output_tokens AS message_output_tokens,
          n.node_id, n.parent_node_id, n.node_order, n.object_key,
          n.object_key_encoded, n.value_type, n.text_value, n.encoded_text_value,
          n.number_value, n.boolean_value
     FROM selected
     ${extensionJoin}${metadataFilter}
    ORDER BY selected.depth DESC, n.node_id`,
    bind: [
      ...bind,
      chatId,
      ...(selectedPage ? [limit, rootOffset] : []),
      ...(mode === "generation" ? [chatId] : []),
    ],
  };
}

export function buildBranchMessageCountQuery(
  chatId: string,
  branchId?: string,
): { sql: string; bind: unknown[] } {
  const branchSeed = branchId === undefined
    ? `SELECT branch.head_message_id
         FROM chat_branches branch
         JOIN chat_active_branches active
           ON active.chat_id = branch.chat_id AND active.branch_id = branch.id
        WHERE branch.chat_id = ?`
    : "SELECT head_message_id FROM chat_branches WHERE chat_id = ? AND id = ?";
  return {
    sql: `WITH RECURSIVE branch_path(message_id) AS (
  ${branchSeed}
  UNION ALL
  SELECT links.parent_message_id
    FROM branch_path path
    JOIN message_branch_links links
      ON links.chat_id = ? AND links.message_id = path.message_id
   WHERE links.parent_message_id IS NOT NULL
)
SELECT COUNT(message_id) AS total FROM branch_path`,
    bind: branchId === undefined
      ? [chatId, chatId]
      : [chatId, branchId, chatId],
  };
}
