-- Defensive invariant for chat_chats.last_message_time.
CREATE OR REPLACE TRIGGER chat_messages_last_message_time
FOR INSERT OR UPDATE OR DELETE ON chat_messages
COMPOUND TRIGGER
    TYPE chat_id_set IS TABLE OF BOOLEAN INDEX BY VARCHAR2(4000);
    affected_chat_ids chat_id_set;

    AFTER EACH ROW IS
    BEGIN
        IF INSERTING OR UPDATING THEN
            affected_chat_ids(:NEW.chat_id) := TRUE;
        END IF;
        IF DELETING OR UPDATING THEN
            affected_chat_ids(:OLD.chat_id) := TRUE;
        END IF;
    END AFTER EACH ROW;

    AFTER STATEMENT IS
        target_chat_id VARCHAR2(4000);
    BEGIN
        target_chat_id := affected_chat_ids.FIRST;
        WHILE target_chat_id IS NOT NULL LOOP
            UPDATE chat_chats ch
               SET last_message_time = (
                   SELECT m.sent_time
                     FROM chat_messages m
                    WHERE m.chat_id = target_chat_id
                    ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                    FETCH FIRST 1 ROW ONLY
               ), updated_at = SYSTIMESTAMP
             WHERE ch.id = target_chat_id;
            target_chat_id := affected_chat_ids.NEXT(target_chat_id);
        END LOOP;
    END AFTER STATEMENT;
END;
/
