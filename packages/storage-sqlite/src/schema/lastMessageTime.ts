export const TRIGGER_NAME = "messages_last_message_time_after_insert";

export const BACKFILL_SQL = `
  UPDATE chats
     SET last_message_time = (
       SELECT sent_time
         FROM messages
        WHERE chat_id = chats.id
        ORDER BY position DESC, sent_time DESC, id DESC
        LIMIT 1
     ),
         updated_at = datetime('now')
`;
