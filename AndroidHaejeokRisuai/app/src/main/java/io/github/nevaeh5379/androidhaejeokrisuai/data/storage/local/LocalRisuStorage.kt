package io.github.nevaeh5379.androidhaejeokrisuai.data.storage.local

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RelationalNodeCodec
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RelationalNodeRow
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LocalRisuStorage(context: Context) : RisuStorage {
    private val helper = RisuSqliteOpenHelper(context.applicationContext)

    override suspend fun init() = withContext(Dispatchers.IO) {
        helper.setWriteAheadLoggingEnabled(true)
        helper.writableDatabase
        Unit
    }

    override suspend fun loadDatabase(): DatabaseOverview = withContext(Dispatchers.IO) {
        val db = helper.readableDatabase
        val revision = currentRevision(db)
        val initialized = db.rawQuery(
            "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
            null,
        ).use { it.moveToFirst() && it.getInt(0) == 1 }
        val characters = mutableListOf<CharacterSummary>()
        db.rawQuery(
            "SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                characters += CharacterSummary(
                    id = cursor.getString(0),
                    name = cursor.getString(1).orEmpty(),
                    image = cursor.stringOrNull(2).orEmpty(),
                    kind = cursor.getString(3).orEmpty(),
                    lastInteraction = cursor.longOrNull(4),
                )
            }
        }
        DatabaseOverview(
            status = if (initialized || characters.isNotEmpty()) "ready" else "empty",
            revision = revision,
            characters = characters,
        )
    }

    override suspend fun loadCharacterChats(characterId: String): List<ChatSummary> = withContext(Dispatchers.IO) {
        val result = mutableListOf<ChatSummary>()
        helper.readableDatabase.rawQuery(
            "SELECT id, name, note, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
            arrayOf(characterId),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += ChatSummary(
                    id = cursor.getString(0),
                    characterId = characterId,
                    name = cursor.getString(1).orEmpty(),
                    note = cursor.getString(2).orEmpty(),
                    lastMessageTime = cursor.longOrNull(3),
                )
            }
        }
        result
    }

    override suspend fun loadChatMessagePage(chatId: String, before: Int?, limit: Int): MessagePage =
        withContext(Dispatchers.IO) {
            val db = helper.readableDatabase
            val total = db.rawQuery("SELECT COUNT(*) FROM messages WHERE chat_id = ?", arrayOf(chatId)).use {
                it.moveToFirst(); it.getInt(0)
            }
            val end = (before ?: total).coerceIn(0, total)
            val safeLimit = limit.coerceIn(1, 500)
            val offset = (end - safeLimit).coerceAtLeast(0)
            val count = end - offset
            val messages = mutableListOf<MessageRecord>()
            db.rawQuery(
                "SELECT id, role, content_text, sender_name, sent_time FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?",
                arrayOf(chatId, count.toString(), offset.toString()),
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0)
                    @Suppress("UNCHECKED_CAST")
                    val full = loadNodeValue(
                        db,
                        "message_extension_nodes",
                        "chat_id = ? AND message_id = ?",
                        arrayOf(chatId, id),
                    ) as? Map<String, Any?>
                    messages += MessageRecord(
                        id = id,
                        chatId = chatId,
                        role = full?.get("role")?.toString() ?: cursor.getString(1).orEmpty(),
                        data = full?.get("data")?.toString() ?: cursor.stringOrNull(2).orEmpty(),
                        name = full?.get("name")?.toString() ?: cursor.stringOrNull(3),
                        time = (full?.get("time") as? Number)?.toLong() ?: cursor.longOrNull(4),
                    )
                }
            }
            MessagePage(messages, offset, total, offset > 0)
        }

    override suspend fun appendMessage(
        chatId: String,
        position: Int,
        message: MessageRecord,
    ): Long = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val revision = currentRevision(db)
            val messageValue = linkedMapOf<String, Any?>(
                "role" to message.role,
                "data" to message.data,
                "time" to message.time,
            ).apply { if (message.name != null) put("name", message.name) }

            val values = ContentValues().apply {
                put("chat_id", chatId)
                put("id", message.id)
                put("position", position)
                put("role", message.role)
                if ('\u0000' !in message.data) put("content_text", message.data) else putNull("content_text")
                putNull("content_encoded")
                if (message.name != null) put("sender_name", message.name) else putNull("sender_name")
                if (message.time != null) put("sent_time", message.time) else putNull("sent_time")
            }
            db.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            db.delete("message_extension_nodes", "chat_id = ? AND message_id = ?", arrayOf(chatId, message.id))
            RelationalNodeCodec.flatten(messageValue).forEach { row -> insertNode(db, chatId, message.id, row) }
            db.execSQL("UPDATE chats SET last_message_time = ?, updated_at = datetime('now') WHERE id = ?", arrayOf<Any?>(message.time, chatId))

            val nextRevision = revision + 1
            db.execSQL(
                "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
                arrayOf(nextRevision),
            )
            db.execSQL(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'android:message', datetime('now'))",
                arrayOf(nextRevision),
            )
            db.setTransactionSuccessful()
            nextRevision
        } finally {
            db.endTransaction()
        }
    }

    private fun currentRevision(db: SQLiteDatabase): Long =
        db.rawQuery("SELECT revision FROM system_storage_meta WHERE singleton = 1", null).use {
            it.moveToFirst(); it.getLong(0)
        }

    private fun loadNodeValue(
        db: SQLiteDatabase,
        table: String,
        where: String,
        args: Array<String>,
    ): Any? {
        val rows = mutableListOf<RelationalNodeRow>()
        db.rawQuery(
            "SELECT node_id, parent_node_id, node_order, object_key, object_key_encoded, value_type, text_value, encoded_text_value, number_value, boolean_value FROM $table WHERE $where ORDER BY node_id",
            args,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                rows += RelationalNodeRow(
                    nodeId = cursor.getInt(0),
                    parentNodeId = if (cursor.isNull(1)) null else cursor.getInt(1),
                    nodeOrder = cursor.getInt(2),
                    objectKey = cursor.stringOrNull(3),
                    objectKeyEncoded = cursor.stringOrNull(4),
                    valueType = cursor.getString(5),
                    textValue = cursor.stringOrNull(6),
                    encodedTextValue = cursor.stringOrNull(7),
                    numberValue = if (cursor.isNull(8)) null else cursor.getDouble(8),
                    booleanValue = if (cursor.isNull(9)) null else cursor.getInt(9),
                )
            }
        }
        return if (rows.isEmpty()) null else RelationalNodeCodec.rebuild(rows)
    }

    private fun insertNode(db: SQLiteDatabase, chatId: String, messageId: String, row: RelationalNodeRow) {
        val values = ContentValues().apply {
            put("chat_id", chatId)
            put("message_id", messageId)
            put("node_id", row.nodeId)
            if (row.parentNodeId == null) putNull("parent_node_id") else put("parent_node_id", row.parentNodeId)
            put("node_order", row.nodeOrder)
            if (row.objectKey == null) putNull("object_key") else put("object_key", row.objectKey)
            if (row.objectKeyEncoded == null) putNull("object_key_encoded") else put("object_key_encoded", row.objectKeyEncoded)
            put("value_type", row.valueType)
            if (row.textValue == null) putNull("text_value") else put("text_value", row.textValue)
            if (row.encodedTextValue == null) putNull("encoded_text_value") else put("encoded_text_value", row.encodedTextValue)
            if (row.numberValue == null) putNull("number_value") else put("number_value", row.numberValue)
            if (row.booleanValue == null) putNull("boolean_value") else put("boolean_value", row.booleanValue)
        }
        db.insertOrThrow("message_extension_nodes", null, values)
    }

    private fun Cursor.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)
    private fun Cursor.longOrNull(index: Int): Long? = if (isNull(index)) null else getLong(index)
}
