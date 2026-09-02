import type { SqlChatBranchSummary } from "../ISqlStorage";
import type { LegacyBranchMigrationPlan } from "../../../../../packages/protocol/legacyBranchMigration.cjs";
import { flattenRelationalValue, RELATIONAL_NODE_COLUMNS } from "./relationalNodeCodec";
import { messageExtensionData } from "./sqliteCommit";
import type { SqliteTransactionStatement } from "./sqliteStorageUtils";

// Kept separate from sqlite-schema.sql because native backends validate and
// reuse existing relational-schema-v3 databases without replaying that file.
export const SQLITE_BRANCH_SCHEMA_STATEMENTS: SqliteTransactionStatement[] = [
  {
    sql: "CREATE TABLE IF NOT EXISTS chat_branches (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, parent_branch_id TEXT, fork_message_id TEXT, head_message_id TEXT, reason TEXT NOT NULL CHECK (reason IN ('root','manual','reroll')), created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, id), FOREIGN KEY (chat_id, parent_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, fork_message_id) REFERENCES messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, head_message_id) REFERENCES messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED)",
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
    sql: "CREATE TABLE IF NOT EXISTS message_branch_links (chat_id TEXT NOT NULL, message_id TEXT NOT NULL, parent_message_id TEXT, origin_branch_id TEXT NOT NULL, PRIMARY KEY (chat_id, message_id), FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE CASCADE, FOREIGN KEY (chat_id, parent_message_id) REFERENCES messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (chat_id, origin_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)",
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
              FROM chats
             WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM chat_branches WHERE chat_id = ?)`,
      bind: [rootId, chatId, chatId],
    },
    {
      sql: `INSERT OR IGNORE INTO message_branch_links
              (chat_id, message_id, parent_message_id, origin_branch_id)
            SELECT chat_id, id,
                   LAG(id) OVER (PARTITION BY chat_id ORDER BY position), ?
              FROM messages
             WHERE chat_id = ?
               AND NOT EXISTS (SELECT 1 FROM chat_active_branches WHERE chat_id = ?)
               AND (SELECT COUNT(*) FROM chat_branches WHERE chat_id = ?) = 1
               AND EXISTS (SELECT 1 FROM chat_branches WHERE chat_id = ? AND id = ?)`,
      bind: [rootId, chatId, chatId, chatId, chatId, rootId],
    },
    {
      sql: `INSERT OR IGNORE INTO chat_active_branches (chat_id, branch_id)
            SELECT id, ? FROM chats
             WHERE id = ?
               AND (SELECT COUNT(*) FROM chat_branches WHERE chat_id = ?) = 1
               AND EXISTS (SELECT 1 FROM chat_branches WHERE chat_id = ? AND id = ?)`,
      bind: [rootId, chatId, chatId, chatId, rootId],
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


const LEGACY_MIGRATION_NODE_BATCH_SIZE = 128;

function nodeInsertStatements(
  table: string,
  ownerColumns: string[],
  ownerValues: unknown[],
  value: unknown,
): SqliteTransactionStatement[] {
  const rows = flattenRelationalValue(value);
  const columns = [...ownerColumns, ...RELATIONAL_NODE_COLUMNS];
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  const statements: SqliteTransactionStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += LEGACY_MIGRATION_NODE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + LEGACY_MIGRATION_NODE_BATCH_SIZE);
    statements.push({
      sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES ${batch.map(() => placeholders).join(",")}`,
      bind: batch.flatMap((row) => [
        ...ownerValues,
        ...RELATIONAL_NODE_COLUMNS.map((column) => row[column]),
      ]),
    });
  }
  return statements;
}

function sqliteMessageStatements(
  chatId: string,
  message: LegacyBranchMigrationPlan["messages"][number],
): SqliteTransactionStatement[] {
  const data = message.data as Record<string, any>;
  const content = flattenRelationalValue(
    typeof data.data === "string" ? data.data : String(data.data ?? ""),
  )[0];
  const extension = messageExtensionData(data, content);
  const statements: SqliteTransactionStatement[] = [{
    sql: `INSERT INTO messages
          (chat_id,id,position,role,content_text,content_encoded,sender_name,sent_time,generation_model,input_tokens,output_tokens)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(chat_id,id) DO UPDATE SET
          position=excluded.position,role=excluded.role,content_text=excluded.content_text,
          content_encoded=excluded.content_encoded,sender_name=excluded.sender_name,
          sent_time=excluded.sent_time,generation_model=excluded.generation_model,
          input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens`,
    bind: [
      chatId,
      message.id,
      message.position,
      data.role ?? "char",
      content.text_value,
      content.encoded_text_value,
      data.name ?? null,
      data.time ?? null,
      data.generationInfo?.model ?? null,
      data.generationInfo?.inputTokens ?? null,
      data.generationInfo?.outputTokens ?? null,
    ],
  }, {
    sql: "DELETE FROM message_extension_nodes WHERE chat_id = ? AND message_id = ?",
    bind: [chatId, message.id],
  }];
  if (Object.keys(extension).length > 0) {
    statements.push(...nodeInsertStatements(
      "message_extension_nodes",
      ["chat_id", "message_id"],
      [chatId, message.id],
      extension,
    ));
  }
  return statements;
}

export function buildSqliteLegacyBranchMigrationStatements(
  chatId: string,
  chatExtensionData: Record<string, unknown>,
  plan: LegacyBranchMigrationPlan,
): SqliteTransactionStatement[] {
  // Keep the legacy branchState extension as archival migration input. Runtime
  // loaders ignore it once persistent branches exist, but preserving it avoids
  // destroying branch-specific script/global state before that state has its own
  // persistent branch table. This is data retention, not a runtime fallback.
  void chatExtensionData;

  const statements: SqliteTransactionStatement[] = [
    { sql: "DELETE FROM chat_active_branches WHERE chat_id = ?", bind: [chatId] },
    { sql: "DELETE FROM message_branch_links WHERE chat_id = ?", bind: [chatId] },
    { sql: "DELETE FROM chat_branches WHERE chat_id = ?", bind: [chatId] },
  ];
  for (const message of plan.messages) {
    statements.push(...sqliteMessageStatements(chatId, message));
  }
  for (const branch of plan.branches) {
    statements.push({
      sql: `INSERT INTO chat_branches
            (chat_id,id,parent_branch_id,fork_message_id,head_message_id,reason,created_at)
            VALUES (?,?,?,?,?,?,?)`,
      bind: [
        chatId,
        branch.id,
        branch.parentBranchId ?? null,
        branch.forkMessageId ?? null,
        branch.headMessageId ?? null,
        branch.reason,
        branch.createdAt,
      ],
    });
  }
  for (const link of plan.links) {
    statements.push({
      sql: `INSERT INTO message_branch_links
            (chat_id,message_id,parent_message_id,origin_branch_id)
            VALUES (?,?,?,?)`,
      bind: [chatId, link.messageId, link.parentMessageId ?? null, link.originBranchId],
    });
  }
  statements.push({
    sql: "INSERT INTO chat_active_branches (chat_id,branch_id) VALUES (?,?)",
    bind: [chatId, plan.activeBranchId],
  });
  return statements;
}
