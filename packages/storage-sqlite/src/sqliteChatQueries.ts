import {
  buildBranchMessageCountQuery,
  buildBranchMessageRowsQuery,
  normalizeSqliteLimit,
  type SqliteTransactionStatement,
} from "./sqliteQueries";

export interface SqliteChatLoadPlan {
  chat: SqliteTransactionStatement;
  extension: SqliteTransactionStatement;
  total: SqliteTransactionStatement;
  messages: SqliteTransactionStatement;
  activeBranch: SqliteTransactionStatement;
  branchCount: SqliteTransactionStatement;
}

export function buildSqliteChatLoadPlan(
  chatId: string,
  requestedMessageLimit?: number,
): SqliteChatLoadPlan {
  const limit =
    requestedMessageLimit === undefined
      ? undefined
      : normalizeSqliteLimit(requestedMessageLimit);
  return {
    chat: {
      sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE id = ?",
      bind: [chatId],
    },
    extension: {
      sql: `SELECT node_id, parent_node_id, node_order, object_key,
                   object_key_encoded, value_type, text_value, encoded_text_value,
                   number_value, boolean_value
              FROM chat_extension_nodes WHERE chat_id = ? ORDER BY node_id`,
      bind: [chatId],
    },
    total: buildBranchMessageCountQuery(chatId),
    messages: buildBranchMessageRowsQuery(chatId, undefined, limit),
    activeBranch: {
      sql: "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
      bind: [chatId],
    },
    branchCount: {
      sql: "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
      bind: [chatId],
    },
  };
}

export function sqliteChatLoadStatements(
  plan: SqliteChatLoadPlan,
): SqliteTransactionStatement[] {
  return [
    plan.chat,
    plan.extension,
    plan.total,
    plan.messages,
    plan.activeBranch,
    plan.branchCount,
  ];
}

export interface SqliteChatRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  note: string | null;
  folder_id: string | null;
  last_message_time: number | null;
}

export interface SqliteChatDocument extends Record<string, unknown> {
  id: string;
  message: unknown[];
  messageOffset: number;
  messageTotal: number;
  messagesFullyLoaded: boolean;
  messagesLoaded: boolean;
  detailsLoaded: boolean;
}

export function hydrateSqliteChatDocument(
  row: SqliteChatRow,
  extension: Record<string, unknown>,
  messages: unknown[],
  total: number,
  activeBranchId: string,
): SqliteChatDocument {
  const chat = { ...extension } as SqliteChatDocument;
  chat.id = row.id;
  chat.name = row.name ?? "";
  chat.note = row.note ?? "";
  chat.folderId = row.folder_id ?? undefined;
  chat.lastDate = row.last_message_time ?? undefined;
  chat.activeBranchId = activeBranchId;
  delete chat.branchState;
  chat.message = messages;
  chat.messageOffset = Math.max(0, total - messages.length);
  chat.messageTotal = total;
  chat.messagesFullyLoaded = chat.messageOffset === 0;
  chat.messagesLoaded = true;
  chat.detailsLoaded = true;
  return chat;
}

export interface SqliteMessagePagePlan {
  statement: SqliteTransactionStatement;
  offset: number;
  total: number;
  hasMore: boolean;
}

export function buildSqliteMessagePagePlan(
  chatId: string,
  before: number | undefined,
  total: number,
  requestedLimit: number,
): SqliteMessagePagePlan {
  const end =
    before === undefined || !Number.isFinite(before)
      ? total
      : Math.min(total, Math.max(0, Math.floor(before)));
  const limit = normalizeSqliteLimit(requestedLimit);
  const offset = Math.max(0, end - limit);
  return {
    statement: buildBranchMessageRowsQuery(
      chatId,
      undefined,
      end - offset,
      "full",
      offset,
    ),
    offset,
    total,
    hasMore: offset > 0,
  };
}
