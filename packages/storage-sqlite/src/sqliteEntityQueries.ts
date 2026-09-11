import type { SqliteSelectRows } from "./sqliteAdminQueries";
import { decodedText } from "./relationalNodeCodec";
import { groupSqliteNodeValues, loadSqliteNodeValue } from "./sqliteNodeValues";

interface CharacterExistsRow extends Record<string, unknown> {
  id: string;
}

interface ChatShellRow extends Record<string, unknown> {
  id: string;
  name: string;
  note: string;
  folder_id: string | null;
  last_message_time: number | null;
}

export interface SqliteChatShell extends Record<string, unknown> {
  id: string;
  message: unknown[];
  messagesLoaded: false;
  detailsLoaded: true;
}
export interface SqliteCharacterDocument extends Record<string, unknown> {
  chaId: string;
  chats: SqliteChatShell[];
  detailsLoaded: true;
}

export async function loadSqliteCharacterChats(
  selectRows: SqliteSelectRows,
  characterId: string,
): Promise<SqliteChatShell[]> {
  const chatRows = await selectRows<ChatShellRow>(
    "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
    [characterId],
  );
  if (chatRows.length === 0) return [];
  const nodeRows = await selectRows(
    `SELECT chat_id, node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value,
            number_value, boolean_value
       FROM chat_extension_nodes
      WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)
      ORDER BY chat_id, node_id`,
    [characterId],
  );
  const values = groupSqliteNodeValues(nodeRows, "chat_id");
  return chatRows.map((row) => {
    const loaded = values.get(row.id);
    const chat =
      loaded && typeof loaded === "object"
        ? ({ ...(loaded as Record<string, unknown>) } as SqliteChatShell)
        : ({} as SqliteChatShell);
    chat.id = row.id;
    chat.name = row.name ?? "";
    chat.note = row.note ?? "";
    chat.folderId = row.folder_id ?? undefined;
    chat.lastDate = row.last_message_time ?? undefined;
    chat.message = [];
    chat.messagesLoaded = false;
    chat.detailsLoaded = true;
    return chat;
  });
}

export async function loadSqliteCharacterDocument(
  selectRows: SqliteSelectRows,
  characterId: string,
): Promise<SqliteCharacterDocument | null> {
  const rows = await selectRows<CharacterExistsRow>(
    "SELECT id FROM characters WHERE id = ?",
    [characterId],
  );
  if (rows.length === 0) return null;
  const extension =
    ((await loadSqliteNodeValue(
      selectRows,
      "character_extension_nodes",
      "character_id = ?",
      [characterId],
    )) as Record<string, unknown> | undefined) ?? {};
  const character = {
    ...extension,
    chaId: characterId,
    detailsLoaded: true,
    chats: await loadSqliteCharacterChats(selectRows, characterId),
  } as SqliteCharacterDocument;
  return character;
}

interface RecentChatRow extends Record<string, unknown> {
  character_id: string;
  character_name: string;
  character_image: string | null;
  character_kind: string;
  chat_id: string;
  chat_position: number;
  chat_name: string;
  folder_id: string | null;
  last_message_time: number | null;
  last_message_text: string | null;
  last_message_encoded: string | null;
}

export interface SqliteRecentChatMetadata {
  characterId: string;
  characterName: string;
  characterImage: string | null;
  characterType: "character" | "group";
  chatId: string;
  chatPosition: number;
  chatName: string;
  folderId: string | null;
  lastDate: number | null;
  lastMessage: string;
}

export async function listSqliteRecentChats(
  selectRows: SqliteSelectRows,
  limit = 50,
  activeChatId?: string,
): Promise<SqliteRecentChatMetadata[]> {
  const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const rows = await selectRows<RecentChatRow>(
    `SELECT c.id AS character_id,
            c.name AS character_name,
            c.image AS character_image,
            c.kind AS character_kind,
            ch.id AS chat_id,
            ch.position AS chat_position,
            ch.name AS chat_name,
            ch.folder_id AS folder_id,
            ch.last_message_time AS last_message_time,
            m.content_text AS last_message_text,
            m.content_encoded AS last_message_encoded
       FROM chats ch
       JOIN characters c ON c.id = ch.character_id
  LEFT JOIN messages m ON m.chat_id = ch.id
     AND m.id = (
            SELECT m2.id FROM messages m2
             WHERE m2.chat_id = ch.id
             ORDER BY m2.position DESC, m2.sent_time DESC, m2.id DESC
             LIMIT 1
          )
      WHERE c.trash_time IS NULL
      ORDER BY CASE
            WHEN ch.id = ? THEN MAX(COALESCE(ch.last_message_time, 0), COALESCE(c.last_interaction_time, 0), 0)
            ELSE COALESCE(ch.last_message_time, c.last_interaction_time, 0)
          END DESC, ch.id
      LIMIT ?`,
    activeChatId ? [activeChatId, normalizedLimit] : [null, normalizedLimit],
  );
  return rows.map((row) => ({
    characterId: row.character_id,
    characterName: row.character_name ?? "",
    characterImage: row.character_image ?? null,
    characterType: row.character_kind === "group" ? "group" : "character",
    chatId: row.chat_id,
    chatPosition: Number(row.chat_position) || 0,
    chatName: row.chat_name ?? "",
    folderId: row.folder_id ?? null,
    lastDate:
      row.last_message_time == null ? null : Number(row.last_message_time),
    lastMessage: decodedText(row.last_message_text, row.last_message_encoded),
  }));
}
