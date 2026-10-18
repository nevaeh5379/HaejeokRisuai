// @vitest-environment node

import { Buffer } from "node:buffer";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import schema from "@risuai/storage-sqlite/schema/schema.sql?raw";
import type { SqliteSelectRows } from "@risuai/storage-sqlite/types";
import {
  listRecentChats,
  SQLITE_RECENT_CHAT_PREVIEW_CHARACTERS,
} from "@risuai/storage-sqlite/queries/entity";

describe("listRecentChats", () => {
  it.each([
    { name: "large plain text", text: "x".repeat(1024 * 1024), encoded: false },
    {
      name: "large UTF-16 fallback",
      text: "x\0\ud800".repeat(8192),
      encoded: true,
    },
    { name: "short plain text", text: "짧은 대화 🧠", encoded: false },
    { name: "short UTF-16 fallback", text: "짧은\0대화\ud800", encoded: true },
  ])("bounds $name before it leaves SQLite", async ({ text, encoded }) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(schema);
      database.exec(
        "INSERT INTO characters (id, position, kind, name) VALUES ('character-1', 0, 'character', 'Character')",
      );
      database.exec(
        "INSERT INTO chats (id, character_id, position, name) VALUES ('chat-1', 'character-1', 0, 'Chat')",
      );
      database
        .prepare(
          "INSERT INTO messages (chat_id, id, position, role, content_text, content_encoded, sent_time) VALUES ('chat-1', 'message-1', 0, 'user', ?, ?, 123)",
        )
        .run(
          encoded ? null : text,
          encoded ? Buffer.from(text, "utf16le").toString("base64") : null,
        );

      let capturedBind: unknown[] | undefined;
      const selectRows: SqliteSelectRows = async <
        T extends Record<string, unknown>,
      >(
        sql: string,
        bind?: unknown[],
      ): Promise<T[]> => {
        capturedBind = bind;
        const rows = database.prepare(sql).all(...(bind as SQLInputValue[]));
        for (const row of rows) {
          expect(
            String(row.last_message_text ?? "").length,
          ).toBeLessThanOrEqual(SQLITE_RECENT_CHAT_PREVIEW_CHARACTERS);
          expect(
            String(row.last_message_encoded ?? "").length,
          ).toBeLessThanOrEqual(11000);
        }
        return rows as T[];
      };

      const result = await listRecentChats(selectRows, 50, "chat-1");

      expect(capturedBind).toEqual(["chat-1", "chat-1", 50]);
      expect(result).toHaveLength(1);
      const preview = result[0]!.lastMessage;
      expect(preview.length).toBe(Math.min(text.length, encoded ? 4095 : 4096));
      expect(preview).toBe(text.slice(0, preview.length));
    } finally {
      database.close();
    }
  });
});
