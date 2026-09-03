import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL } from "./sqliteLastMessageTime";

describe("SQLite last-message-time trigger", () => {
  it("backfills existing chats and guards direct message writes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sqliteSchemaSql);
    db.exec(
      "INSERT INTO characters (id, position, kind, name) VALUES ('c', 0, 'character', 'C')",
    );
    db.exec(
      "INSERT INTO chats (id, character_id, position, name) VALUES ('chat', 'c', 0, 'Chat')",
    );
    db.exec("DROP TRIGGER messages_last_message_time_after_insert");
    db.exec("DROP TRIGGER messages_last_message_time_after_update");
    db.exec("DROP TRIGGER messages_last_message_time_after_delete");
    db.exec(
      "INSERT INTO messages (chat_id, id, position, role, content_text, sent_time) VALUES ('chat', 'm1', 0, 'user', 'one', 100)",
    );
    db.exec(SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL);
    db.exec(sqliteSchemaSql);
    const read = () =>
      (
        db
          .prepare("SELECT last_message_time FROM chats WHERE id='chat'")
          .get() as { last_message_time: number | null }
      ).last_message_time;
    expect(read()).toBe(100);

    db.exec(
      "INSERT INTO messages (chat_id, id, position, role, content_text, sent_time) VALUES ('chat', 'm2', 1, 'char', 'two', 200)",
    );
    expect(read()).toBe(200);
    db.exec(
      "UPDATE messages SET sent_time = 50 WHERE chat_id='chat' AND id='m2'",
    );
    expect(read()).toBe(50);
    db.exec("DELETE FROM messages WHERE chat_id='chat' AND id='m2'");
    expect(read()).toBe(100);
    db.exec("DELETE FROM messages WHERE chat_id='chat' AND id='m1'");
    expect(read()).toBeNull();
    db.close();
  });
});
