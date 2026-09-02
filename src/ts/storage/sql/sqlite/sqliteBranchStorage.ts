import type { SqlChatBranchSummary } from "../ISqlStorage";
import type { SqliteTransactionStatement } from "./sqliteStorageUtils";

// Kept separate from sqlite-schema.sql because native backends validate and
// reuse existing relational-schema-v3 databases without replaying that file.
export const SQLITE_BRANCH_SCHEMA_STATEMENTS: SqliteTransactionStatement[] = [
  {
    sql: "CREATE TABLE IF NOT EXISTS chat_branches (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, parent_branch_id TEXT, fork_message_id TEXT, head_message_id TEXT, reason TEXT NOT NULL CHECK (reason IN ('root','manual','reroll')), created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, id), FOREIGN KEY (chat_id, parent_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, fork_message_id) REFERENCES messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, head_message_id) REFERENCES messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED)",
    bind: [],
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS chat_branches_parent_idx ON chat_branches (chat_id, parent_branch_id, created_at)",
    bind: [],
  },
  {
    sql: "CREATE TABLE IF NOT EXISTS chat_active_branches (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, branch_id TEXT NOT NULL, FOREIGN KEY (chat_id, branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)",
    bind: [],
  },
  {
    sql: "CREATE TABLE IF NOT EXISTS message_branch_links (chat_id TEXT NOT NULL, message_id TEXT NOT NULL, parent_message_id TEXT, origin_branch_id TEXT NOT NULL, PRIMARY KEY (chat_id, message_id), FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE CASCADE, FOREIGN KEY (chat_id, parent_message_id) REFERENCES messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, origin_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)",
    bind: [],
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS message_branch_parent_idx ON message_branch_links (chat_id, parent_message_id)",
    bind: [],
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS message_branch_origin_idx ON message_branch_links (chat_id, origin_branch_id)",
    bind: [],
  },
];

export function rootBranchId(chatId: string): string {
  return `${chatId}:root`;
}

/**
 * Converts a legacy linear chat into a root branch entirely inside SQLite.
 * The window function avoids one JS/native bridge statement per message.
 */
export function ensureSqliteBranchGraphStatements(
  chatId: string,
): SqliteTransactionStatement[] {
  const rootId = rootBranchId(chatId);
  return [
    {
      sql: `INSERT OR IGNORE INTO chat_branches
              (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
            SELECT id, ?, NULL, NULL,
                   (SELECT id FROM messages WHERE chat_id = chats.id ORDER BY position DESC LIMIT 1),
                   'root', 0
              FROM chats WHERE id = ?`,
      bind: [rootId, chatId],
    },
    {
      sql: `INSERT OR IGNORE INTO message_branch_links
              (chat_id, message_id, parent_message_id, origin_branch_id)
            SELECT chat_id, id,
                   LAG(id) OVER (PARTITION BY chat_id ORDER BY position), ?
              FROM messages WHERE chat_id = ?`,
      bind: [rootId, chatId],
    },
    {
      sql: `INSERT OR IGNORE INTO chat_active_branches (chat_id, branch_id)
            SELECT id, ? FROM chats WHERE id = ?`,
      bind: [rootId, chatId],
    },
  ];
}

export interface SqliteChatBranchRow extends Record<string, unknown> {
  id: string;
  chat_id: string;
  parent_branch_id: string | null;
  fork_message_id: string | null;
  head_message_id: string | null;
  reason: "root" | "manual" | "reroll";
  created_at: number;
}

export function mapSqliteChatBranchRow(
  row: SqliteChatBranchRow,
): SqlChatBranchSummary {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentBranchId: row.parent_branch_id ?? undefined,
    forkMessageId: row.fork_message_id ?? undefined,
    headMessageId: row.head_message_id ?? undefined,
    reason: row.reason,
    createdAt: Number(row.created_at) || 0,
  };
}
