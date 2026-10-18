-- Defensive invariant for [chat].[chats].last_message_time.
-- SQL Server triggers are statement-level and use inserted/deleted row sets.
EXEC(N'CREATE OR ALTER TRIGGER [chat].[messages_last_message_time]
ON [chat].[messages]
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    ;WITH affected AS (
        SELECT chat_id FROM inserted
        UNION
        SELECT chat_id FROM deleted
    )
    UPDATE ch
       SET last_message_time = latest.sent_time,
           updated_at = SYSDATETIMEOFFSET()
      FROM [chat].[chats] ch
      JOIN affected a ON a.chat_id = ch.id
      OUTER APPLY (
          SELECT TOP (1) m.sent_time
            FROM [chat].[messages] m
           WHERE m.chat_id = ch.id
           ORDER BY m.position DESC, m.sent_time DESC, m.id DESC
      ) latest;
END');
