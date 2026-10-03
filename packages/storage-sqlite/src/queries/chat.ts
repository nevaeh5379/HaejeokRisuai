import * as sqliteMessages from "./messages";
import type { SqliteStatement } from "../types";
import { normalizeLimit } from "../util";

export interface LoadPlan {
  chat: SqliteStatement;
  extension: SqliteStatement;
  total: SqliteStatement;
  messages: SqliteStatement;
  activeBranch: SqliteStatement;
  branchCount: SqliteStatement;
}

export function buildLoadPlan(
  chatId: string,
  requestedMessageLimit?: number,
): LoadPlan {
  const limit =
    requestedMessageLimit === undefined
      ? undefined
      : normalizeLimit(requestedMessageLimit);
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
    total: sqliteMessages.buildBranchCountQuery(chatId),
    messages: sqliteMessages.buildBranchRowsQuery(chatId, undefined, limit),
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

export function loadStatements(plan: LoadPlan): SqliteStatement[] {
  return [
    plan.chat,
    plan.extension,
    plan.total,
    plan.messages,
    plan.activeBranch,
    plan.branchCount,
  ];
}

export interface Row extends Record<string, unknown> {
  id: string;
  name: string | null;
  note: string | null;
  folder_id: string | null;
  last_message_time: number | null;
}

export interface ChatDocument extends Record<string, unknown> {
  id: string;
  message: unknown[];
  messageOffset: number;
  messageTotal: number;
  messagesFullyLoaded: boolean;
  messagesLoaded: boolean;
  detailsLoaded: boolean;
}

export function hydrateDocument(
  row: Row,
  extension: Record<string, unknown>,
  messages: unknown[],
  total: number,
  activeBranchId: string,
): ChatDocument {
  const chat = { ...extension } as ChatDocument;
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

export interface MessagePagePlan {
  statement: SqliteStatement;
  offset: number;
  total: number;
  hasMore: boolean;
}

export function buildMessagePagePlan(
  chatId: string,
  before: number | undefined,
  total: number,
  requestedLimit: number,
): MessagePagePlan {
  const end =
    before === undefined || !Number.isFinite(before)
      ? total
      : Math.min(total, Math.max(0, Math.floor(before)));
  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, end - limit);
  return {
    statement: sqliteMessages.buildBranchRowsQuery(
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
