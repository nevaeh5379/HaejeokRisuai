import * as nodeCodec from "../schema/codec";

// ── Shared message batch query (web / tauri / capacitor) ─────────────

export type LoadMode = "full" | "generation" | "graph";

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
export function buildRowsQuery(
  chatId: string,
  limit: number | undefined,
  offset: number,
  newest: boolean,
  mode: LoadMode = "full",
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
  const extensionJoin =
    mode === "graph"
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

/** Lightweight unique-message read used by the branch graph modal. */
export function buildGraphRowsQuery(chatId: string): {
  sql: string;
  bind: unknown[];
} {
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

export function buildGraphPageQuery(
  chatId: string,
  offset: number,
  limit: number,
): { sql: string; bind: unknown[] } {
  return {
    sql: `WITH selected AS (
      SELECT messages.id, messages.position, messages.role,
             messages.content_text, messages.content_encoded,
             messages.sender_name, messages.sent_time,
             messages.generation_model, messages.input_tokens, messages.output_tokens,
             links.parent_message_id, links.origin_branch_id
        FROM message_branch_links links
        JOIN messages ON messages.chat_id = links.chat_id AND messages.id = links.message_id
       WHERE links.chat_id = ?
       ORDER BY messages.position, messages.id
       LIMIT ? OFFSET ?
    )
    SELECT selected.id AS message_id, selected.position AS message_position,
           selected.role AS message_role, selected.content_text AS message_content_text,
           selected.content_encoded AS message_content_encoded,
           selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
           selected.generation_model AS message_generation_model,
           selected.input_tokens AS message_input_tokens,
           selected.output_tokens AS message_output_tokens,
           selected.parent_message_id AS graph_parent_message_id,
           selected.origin_branch_id AS graph_origin_branch_id,
           n.node_id, n.parent_node_id, n.node_order, n.object_key,
           n.object_key_encoded, n.value_type, n.text_value, n.encoded_text_value,
           n.number_value, n.boolean_value
      FROM selected
 LEFT JOIN message_extension_nodes n
        ON n.chat_id = ? AND n.message_id = selected.id
     ORDER BY selected.position, selected.id, n.node_id`,
    bind: [chatId, limit, offset, chatId],
  };
}

export function rebuildGraphLinks(rows: Record<string, unknown>[]): Array<{
  messageId: string;
  parentMessageId?: string;
  originBranchId: string;
}> {
  const links = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const messageId = String(row.message_id);
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    links.push({
      messageId,
      position: Number(row.message_position) || 0,
      parentMessageId:
        row.graph_parent_message_id == null
          ? undefined
          : String(row.graph_parent_message_id),
      originBranchId: String(row.graph_origin_branch_id),
    });
  }
  return links;
}

export function buildGraphCountQuery(chatId: string): {
  sql: string;
  bind: unknown[];
} {
  return {
    sql: "SELECT COUNT(*) AS total FROM message_branch_links WHERE chat_id = ?",
    bind: [chatId],
  };
}

/**
 * Reads one persisted branch by walking from its head to the root. Unlike the
 * legacy position query this never touches messages that belong only to an
 * inactive branch.
 */
export function buildBranchRowsQuery(
  chatId: string,
  branchId: string | undefined,
  limit: number | undefined,
  mode: LoadMode = "full",
  rootOffset?: number,
): { sql: string; bind: unknown[] } {
  const recursionLimit =
    limit === undefined || rootOffset !== undefined
      ? ""
      : " AND path.depth + 1 < ?";
  const branchSeed =
    branchId === undefined
      ? `SELECT branch.head_message_id, 0
         FROM chat_branches branch
         JOIN chat_active_branches active
           ON active.chat_id = branch.chat_id AND active.branch_id = branch.id
        WHERE branch.chat_id = ?`
      : `SELECT head_message_id, 0
         FROM chat_branches
        WHERE chat_id = ? AND id = ?`;
  const bind: unknown[] =
    branchId === undefined ? [chatId, chatId] : [chatId, branchId, chatId];
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
      bind: [...bind, chatId, ...(selectedPage ? [limit, rootOffset] : [])],
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
  const extensionJoin =
    "LEFT JOIN message_extension_nodes n ON n.chat_id = selected.chat_id AND n.message_id = selected.id";
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

export function buildBranchCountQuery(
  chatId: string,
  branchId?: string,
): { sql: string; bind: unknown[] } {
  const branchSeed =
    branchId === undefined
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
    bind:
      branchId === undefined ? [chatId, chatId] : [chatId, branchId, chatId],
  };
}

// ── Row mapping ──────────────────────────────────────────────────────

export interface HydratedMessage {
  [key: string]: unknown;
  role: string;
  data: string;
  chatId?: string;
  time?: number;
  name?: string;
  isComment?: boolean;
  generationInfo?: {
    [key: string]: unknown;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

/** Rebuilds persisted SQLite message rows without depending on app domain types. */
export function rebuildRows<TMessage extends object = HydratedMessage>(
  rows: Record<string, unknown>[],
): TMessage[] {
  const nodeGroups = new Map<string, nodeCodec.NodeRow[]>();
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
    nodes.push(row as nodeCodec.NodeRow);
    nodeGroups.set(id, nodes);
  }

  return orderedIds.map((id) => {
    const core = coreRows.get(id)!;
    const nodes = nodeGroups.get(id);
    const rebuilt = nodes?.length ? nodeCodec.rebuild(nodes) : {};
    const message = (
      rebuilt && typeof rebuilt === "object" ? rebuilt : {}
    ) as TMessage & HydratedMessage;

    message.role = String(core.message_role ?? "char");
    if (!Object.prototype.hasOwnProperty.call(message, "data")) {
      message.data = nodeCodec.decodeText(
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

export function rebuildGraphMessages<TMessage extends object = HydratedMessage>(
  rows: Record<string, unknown>[],
): TMessage[] {
  const comments = new Map<string, boolean>();
  for (const row of rows) {
    if (row.graph_is_comment == null) continue;
    comments.set(String(row.message_id), Boolean(row.graph_is_comment));
  }
  const messages = rebuildRows<TMessage>(rows);
  for (const message of messages as Array<TMessage & HydratedMessage>) {
    if (message.chatId && comments.has(message.chatId)) {
      message.isComment = comments.get(message.chatId)!;
    }
  }
  return messages;
}
