-- Defensive invariant for chat.chats.last_message_time.
-- Normal application commits also recompute once per affected chat.
CREATE OR REPLACE FUNCTION chat.recompute_last_message_time(target_ids TEXT[])
RETURNS VOID LANGUAGE SQL AS $$
    UPDATE chat.chats AS ch
       SET last_message_time = (
           SELECT m.sent_time
             FROM chat.messages AS m
            WHERE m.chat_id = ch.id
            ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
            LIMIT 1
       ), updated_at = NOW()
     WHERE ch.id = ANY(target_ids)
$$;

CREATE OR REPLACE FUNCTION chat.refresh_last_message_time_from_messages()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_ids TEXT[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT ARRAY_AGG(DISTINCT chat_id) INTO target_ids FROM new_rows;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT ARRAY_AGG(DISTINCT chat_id) INTO target_ids
          FROM (SELECT chat_id FROM old_rows UNION SELECT chat_id FROM new_rows) ids;
    ELSE
        SELECT ARRAY_AGG(DISTINCT chat_id) INTO target_ids FROM old_rows;
    END IF;
    IF target_ids IS NOT NULL THEN
        PERFORM chat.recompute_last_message_time(target_ids);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS messages_last_message_time_after_insert ON chat.messages;
CREATE TRIGGER messages_last_message_time_after_insert
AFTER INSERT ON chat.messages
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION chat.refresh_last_message_time_from_messages();

DROP TRIGGER IF EXISTS messages_last_message_time_after_update ON chat.messages;
CREATE TRIGGER messages_last_message_time_after_update
AFTER UPDATE ON chat.messages
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION chat.refresh_last_message_time_from_messages();

DROP TRIGGER IF EXISTS messages_last_message_time_after_delete ON chat.messages;
CREATE TRIGGER messages_last_message_time_after_delete
AFTER DELETE ON chat.messages
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION chat.refresh_last_message_time_from_messages();
