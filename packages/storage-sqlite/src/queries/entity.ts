import * as sqliteNodes from "./nodes";
import * as nodeCodec from "../schema/codec";
import type { SqliteSelectRows } from "../types";

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

export interface ChatShell extends Record<string, unknown> {
  id: string;
  message: unknown[];
  messagesLoaded: false;
  detailsLoaded: true;
}
export interface CharacterDocument extends Record<string, unknown> {
  chaId: string;
  chats: ChatShell[];
  detailsLoaded: true;
}

export async function loadCharacterChats(
  selectRows: SqliteSelectRows,
  characterId: string,
): Promise<ChatShell[]> {
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
  const values = sqliteNodes.groupValues(nodeRows, "chat_id");
  return chatRows.map((row) => {
    const loaded = values.get(row.id);
    const chat =
      loaded && typeof loaded === "object"
        ? ({ ...(loaded as Record<string, unknown>) } as ChatShell)
        : ({} as ChatShell);
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

export async function loadCharacterDocument(
  selectRows: SqliteSelectRows,
  characterId: string,
): Promise<CharacterDocument | null> {
  const rows = await selectRows<CharacterExistsRow>(
    "SELECT id FROM characters WHERE id = ?",
    [characterId],
  );
  if (rows.length === 0) return null;
  const extension =
    ((await sqliteNodes.loadValue(
      selectRows,
      "character_extension_nodes",
      "character_id = ?",
      [characterId],
    )) as Record<string, unknown> | undefined) ?? {};
  const character = {
    ...extension,
    chaId: characterId,
    detailsLoaded: true,
    chats: await loadCharacterChats(selectRows, characterId),
  } as CharacterDocument;
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

export interface RecentChatMetadata {
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

export async function listRecentChats(
  selectRows: SqliteSelectRows,
  limit = 50,
  activeChatId?: string,
): Promise<RecentChatMetadata[]> {
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
      ORDER BY CASE WHEN ch.id = ? THEN 1 ELSE 0 END DESC,
          CASE
            WHEN ch.id = ? THEN MAX(COALESCE(ch.last_message_time, 0), COALESCE(c.last_interaction_time, 0), 0)
            WHEN ch.last_message_time IS NOT NULL THEN ch.last_message_time
            -- Old databases can lack per-chat timestamps. Keep one
            -- representative session per character eligible for the legacy
            -- character timestamp without making every empty sibling recent.
            WHEN ch.position = 0 THEN COALESCE(c.last_interaction_time, 0)
            ELSE 0
          END DESC, ch.id
      LIMIT ?`,
    activeChatId
      ? [activeChatId, activeChatId, normalizedLimit]
      : [null, null, normalizedLimit],
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
    lastMessage: nodeCodec.decodeText(
      row.last_message_text,
      row.last_message_encoded,
    ),
  }));
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
    bind: [characterId, ...CHARACTER_ASSET_FIELD_KEYS, characterId],
  };
}
