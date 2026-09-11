import type {
  NodePostgresBotChatStats,
  NodePostgresCharacterSearchResult,
  NodePostgresColumnInfo,
  NodePostgresMessageSearchResult,
  NodePostgresTableData,
  NodePostgresTableInfo,
  NodePostgresTokenUsage,
} from "@risuai/protocol/databaseApi.cjs";
import {
  normalizeSqliteLimit,
  type SqliteTransactionStatement,
} from "./sqliteQueries";

export type SqliteSelectRows = <T extends Record<string, unknown>>(
  sql: string,
  bind?: unknown[],
) => Promise<T[]>;

export type SqliteSelectRowSets = (
  queries: SqliteTransactionStatement[],
) => Promise<Record<string, unknown>[][]>;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function searchSqliteMessages(
  selectRows: SqliteSelectRows,
  query: string,
  limit = 50,
): Promise<NodePostgresMessageSearchResult[]> {
  const rows = await selectRows<{
    chat_id: string;
    id: string;
    position: number;
    role: string;
    sent_time: number | null;
    sender_name: string | null;
    content_text: string | null;
  }>(
    `SELECT chat_id, id, position, role, sent_time, sender_name, content_text
       FROM messages WHERE content_text LIKE ? ORDER BY sent_time DESC LIMIT ?`,
    [`%${query}%`, normalizeSqliteLimit(limit)],
  );
  return rows.map((row) => ({
    storageState: "active" as const,
    archiveId: null,
    characterId: null,
    characterName: null,
    chatId: row.chat_id,
    chatName: "",
    messageId: row.id,
    position: Number(row.position),
    role: row.role as "user" | "char",
    sentTime: row.sent_time != null ? Number(row.sent_time) : null,
    senderName: row.sender_name ?? null,
    snippet: (row.content_text ?? "").slice(0, 200),
  }));
}

export async function getSqliteTokenUsage(
  selectRows: SqliteSelectRows,
): Promise<NodePostgresTokenUsage[]> {
  const rows = await selectRows<{
    model: string;
    message_count: number;
    input_tokens: number;
    output_tokens: number;
  }>(
    `SELECT COALESCE(generation_model, 'unknown') AS model, COUNT(*) AS message_count,
       COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM messages WHERE generation_model IS NOT NULL GROUP BY generation_model`,
  );
  return rows.map((row) => ({
    model: row.model,
    messageCount: Number(row.message_count),
    totalInputTokens: Number(row.input_tokens),
    totalOutputTokens: Number(row.output_tokens),
  }));
}

export async function getSqliteBotChatStats(
  selectRows: SqliteSelectRows,
): Promise<NodePostgresBotChatStats[]> {
  const chars = await selectRows<{
    id: string;
    name: string;
    image: string | null;
    kind: string;
    last_interaction_time: number | null;
  }>(
    "SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position ASC",
  );
  const chatRows = await selectRows<{
    id: string;
    character_id: string;
    last_message_time: number | null;
  }>("SELECT id, character_id, last_message_time FROM chats");
  const msgRows = await selectRows<{
    chat_id: string;
    role: string;
    sent_time: number | null;
    content_length: number;
  }>(
    "SELECT chat_id, role, sent_time, length(COALESCE(content_text, content_encoded, '')) AS content_length FROM messages",
  );

  const chatsByChar = new Map<
    string,
    { id: string; lastMessageTime: number | null }[]
  >();
  for (const chat of chatRows) {
    const list = chatsByChar.get(chat.character_id) ?? [];
    list.push({
      id: chat.id,
      lastMessageTime:
        chat.last_message_time != null ? Number(chat.last_message_time) : null,
    });
    chatsByChar.set(chat.character_id, list);
  }
  const msgsByChat = new Map<
    string,
    { role: string; sentTime: number | null; len: number }[]
  >();
  for (const message of msgRows) {
    const list = msgsByChat.get(message.chat_id) ?? [];
    list.push({
      role: message.role,
      sentTime: message.sent_time != null ? Number(message.sent_time) : null,
      len: Number(message.content_length),
    });
    msgsByChat.set(message.chat_id, list);
  }

  return chars.map((character) => {
    const chats = chatsByChar.get(character.id) ?? [];
    let totalMessages = 0;
    let userMessages = 0;
    let botMessages = 0;
    let longestSessionMessages = 0;
    let lastActiveDate =
      character.last_interaction_time != null
        ? Number(character.last_interaction_time)
        : null;
    let totalBotLen = 0;
    let totalUserLen = 0;
    for (const chat of chats) {
      if (
        chat.lastMessageTime != null &&
        (lastActiveDate == null || chat.lastMessageTime > lastActiveDate)
      ) {
        lastActiveDate = chat.lastMessageTime;
      }
      const messages = msgsByChat.get(chat.id) ?? [];
      longestSessionMessages = Math.max(
        longestSessionMessages,
        messages.length,
      );
      totalMessages += messages.length;
      for (const message of messages) {
        if (
          message.sentTime != null &&
          (lastActiveDate == null || message.sentTime > lastActiveDate)
        ) {
          lastActiveDate = message.sentTime;
        }
        if (message.role === "user") {
          userMessages += 1;
          totalUserLen += message.len;
        } else {
          botMessages += 1;
          totalBotLen += message.len;
        }
      }
    }
    const isGroup = character.kind === "group";
    const totalSessions = chats.length;
    return {
      id: character.id,
      name: character.name || (isGroup ? "Group" : "Character"),
      avatarKey: character.image ?? undefined,
      image: character.image ?? undefined,
      isGroup,
      totalSessions,
      totalMessages,
      userMessages,
      botMessages,
      longestSessionMessages,
      lastActiveDate,
      avgBotMessageLen:
        botMessages > 0 ? Math.round(totalBotLen / botMessages) : 0,
      avgUserMessageLen:
        userMessages > 0 ? Math.round(totalUserLen / userMessages) : 0,
      avgMessagesPerSession:
        totalSessions > 0
          ? Number((totalMessages / totalSessions).toFixed(1))
          : 0,
    };
  });
}

async function getColumns(
  selectRows: SqliteSelectRows,
  table: string,
): Promise<NodePostgresColumnInfo[]> {
  const rows = await selectRows<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>(`PRAGMA table_info(${quoteIdentifier(table)})`);
  if (rows.length === 0) throw new Error(`SQLite table not found: ${table}`);
  return rows.map((row) => ({
    name: String(row.name ?? ""),
    dataType: String(row.type ?? "UNKNOWN") || "UNKNOWN",
    nullable: Number(row.notnull ?? 0) === 0,
    primaryKey: Number(row.pk ?? 0) > 0,
  }));
}

export async function listSqliteDbTables(
  selectRows: SqliteSelectRows,
  selectRowSets: SqliteSelectRowSets,
): Promise<NodePostgresTableInfo[]> {
  const rows = await selectRows<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const counts = await selectRowSets(
    rows.map((row) => ({
      sql: `SELECT COUNT(*) AS total FROM ${quoteIdentifier(String(row.name))}`,
      bind: [],
    })),
  );
  return rows.map((row, index) => ({
    name: String(row.name),
    rowCount: Number(counts[index]?.[0]?.total ?? 0),
  }));
}

export async function getSqliteDbTableData(
  selectRows: SqliteSelectRows,
  selectRowSets: SqliteSelectRowSets,
  table: string,
  options: {
    offset?: number;
    limit?: number;
    sortColumn?: string;
    sortOrder?: "asc" | "desc";
    search?: string;
    columns?: string[];
  } = {},
): Promise<NodePostgresTableData> {
  const allColumns = await getColumns(selectRows, table);
  const columnNames = new Set(allColumns.map((column) => column.name));
  const requested = options.columns?.filter((name) => columnNames.has(name));
  const columns = requested?.length
    ? allColumns.filter((column) => requested.includes(column.name))
    : allColumns;
  if (columns.length === 0)
    throw new Error(`SQLite table has no columns: ${table}`);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = normalizeSqliteLimit(options.limit ?? 50);
  const quotedTable = quoteIdentifier(table);
  const search = options.search?.trim() ?? "";
  const where = search
    ? ` WHERE ${allColumns.map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ? COLLATE NOCASE`).join(" OR ")}`
    : "";
  const searchBinds = search ? allColumns.map(() => `%${search}%`) : [];
  const sortColumn =
    options.sortColumn && columnNames.has(options.sortColumn)
      ? options.sortColumn
      : "";
  const orderBy = sortColumn
    ? ` ORDER BY ${quoteIdentifier(sortColumn)} ${options.sortOrder === "desc" ? "DESC" : "ASC"}`
    : "";
  const selection = columns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const [countRows, dataRows] = await selectRowSets([
    {
      sql: `SELECT COUNT(*) AS total FROM ${quotedTable}${where}`,
      bind: searchBinds,
    },
    {
      sql: `SELECT ${selection} FROM ${quotedTable}${where}${orderBy} LIMIT ? OFFSET ?`,
      bind: [...searchBinds, limit, offset],
    },
  ]);
  return {
    table,
    columns,
    allColumns,
    rows: dataRows ?? [],
    offset,
    limit,
    total: Number(countRows?.[0]?.total ?? 0),
  };
}

export async function searchSqliteCharacters(
  selectRows: SqliteSelectRows,
  field: "tag" | "name",
  value: string,
  limit = 100,
): Promise<NodePostgresCharacterSearchResult[]> {
  const sql =
    field === "tag"
      ? `SELECT DISTINCT c.id, c.name, c.image, c.kind FROM characters c
         JOIN character_tags t ON t.character_id = c.id WHERE t.tag LIKE ? LIMIT ?`
      : "SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?";
  const rows = await selectRows<{
    id: string;
    name: string;
    image: string | null;
    kind: string;
  }>(sql, [`%${value}%`, normalizeSqliteLimit(limit)]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    image: row.image ?? null,
    kind: (row.kind as "character" | "group") ?? "character",
  }));
}
