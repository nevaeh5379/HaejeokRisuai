import { describe, expect, it } from "vitest";
import type { SqliteSelectRows } from "./sqliteAdminQueries";
import {
  listSqliteRecentChats,
  SQLITE_RECENT_CHAT_PREVIEW_CHARACTERS,
} from "./sqliteEntityQueries";

describe("listSqliteRecentChats", (): void => {
  it("bounds the last-message projection before it leaves SQLite", async (): Promise<void> => {
    let capturedSql = "";
    let capturedBind: unknown[] | undefined;
    const preview = "x".repeat(SQLITE_RECENT_CHAT_PREVIEW_CHARACTERS);
    const selectRows: SqliteSelectRows = async <
      T extends Record<string, unknown>,
    >(
      sql: string,
      bind?: unknown[],
    ): Promise<T[]> => {
      capturedSql = sql;
      capturedBind = bind;
      return [
        {
          character_id: "character-1",
          character_name: "Character",
          character_image: null,
          character_kind: "character",
          chat_id: "chat-1",
          chat_position: 0,
          chat_name: "Chat",
          folder_id: null,
          last_message_time: 123,
          last_message_text: preview,
          last_message_encoded: null,
        } as unknown as T,
      ];
    };

    const result = await listSqliteRecentChats(selectRows, 50, "chat-1");

    expect(capturedSql).toContain(
      `substr(m.content_text, 1, ${SQLITE_RECENT_CHAT_PREVIEW_CHARACTERS})`,
    );
    expect(capturedSql).toContain("substr(m.content_encoded, 1, 10920)");
    expect(capturedBind).toEqual(["chat-1", "chat-1", 50]);
    expect(result).toHaveLength(1);
    expect(result[0]?.lastMessage).toBe(preview);
  });
});
