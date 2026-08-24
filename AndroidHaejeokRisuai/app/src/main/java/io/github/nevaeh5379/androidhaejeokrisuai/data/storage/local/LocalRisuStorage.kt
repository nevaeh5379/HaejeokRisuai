package io.github.nevaeh5379.androidhaejeokrisuai.data.storage.local

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterImportPayload
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatPromptContext
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettingsMapper
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.LoreEntry
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.PositionedMessage
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.loreEntriesFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.regexScriptsFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.triggerScriptsFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RelationalNodeCodec
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RelationalNodeRow
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class LocalRisuStorage(context: Context) : RisuStorage {
    private val appContext = context.applicationContext
    private val helper = RisuSqliteOpenHelper(appContext)

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
        val generationState = loadGenerationState(db)
        DatabaseOverview(
            status = if (initialized || characters.isNotEmpty()) "ready" else "empty",
            revision = revision,
            characters = characters,
            generationSettings = generationState.settings,
            activePresetId = generationState.activePresetId,
            activePresetName = generationState.activePresetName,
        )
    }

    override suspend fun loadCharacterProfile(characterId: String): CharacterProfile = withContext(Dispatchers.IO) {
        val db = helper.readableDatabase
        val row = db.rawQuery("SELECT name FROM characters WHERE id = ?", arrayOf(characterId)).use { cursor ->
            if (!cursor.moveToFirst()) throw IllegalArgumentException("Character not found: $characterId")
            cursor.getString(0).orEmpty()
        }
        @Suppress("UNCHECKED_CAST")
        val full = loadNodeValue(
            db,
            "character_extension_nodes",
            "character_id = ?",
            arrayOf(characterId),
        ) as? Map<String, Any?> ?: emptyMap()
        CharacterProfile(
            id = characterId,
            name = full["name"]?.toString()?.takeIf { it.isNotBlank() } ?: row,
            firstMessage = full["firstMessage"]?.toString().orEmpty(),
            alternateGreetings = (full["alternateGreetings"] as? List<*>)?.mapNotNull { it?.toString() }.orEmpty(),
            exampleMessage = full["exampleMessage"]?.toString().orEmpty(),
            defaultVariables = full["defaultVariables"]?.toString().orEmpty(),
            regexScripts = regexScriptsFromValue(full["customscript"]),
            triggerScripts = triggerScriptsFromValue(full["triggerscript"]),
            description = full["desc"]?.toString().orEmpty(),
            personality = full["personality"]?.toString().orEmpty(),
            scenario = full["scenario"]?.toString().orEmpty(),
            systemPrompt = full["systemPrompt"]?.toString().orEmpty(),
            replaceGlobalNote = full["replaceGlobalNote"]?.toString().orEmpty(),
            globalLore = loreEntriesFromValue(full["globalLore"]),
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

    override suspend fun importCharacter(payload: CharacterImportPayload): CharacterSummary = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        val id = java.util.UUID.randomUUID().toString()
        val imageFile = payload.imageBytes?.let { image ->
            val directory = java.io.File(appContext.filesDir, "character-images").apply { mkdirs() }
            java.io.File(directory, "$id.png").also { it.writeBytes(image) }
        }
        val imageRef = imageFile?.toURI()?.toString().orEmpty()
        val data = payload.data.toMutableMap().apply {
            put("name", payload.name)
            put("image", imageRef)
            put("type", "character")
        }
        db.beginTransaction()
        try {
            val revision = currentRevision(db)
            val position = db.rawQuery("SELECT COUNT(*) FROM characters", null).use {
                it.moveToFirst(); it.getInt(0)
            }
            val now = System.currentTimeMillis()
            val characterValues = ContentValues().apply {
                put("id", id)
                put("position", position)
                put("kind", "character")
                put("name", payload.name)
                if (imageRef.isBlank()) putNull("image") else put("image", imageRef)
                putNull("trash_time")
                put("creation_time", (data["creationDate"] as? Number)?.toLong()
                    ?: (data["creation_date"] as? Number)?.toLong() ?: now)
                put("modification_time", (data["modificationDate"] as? Number)?.toLong()
                    ?: (data["modification_date"] as? Number)?.toLong() ?: now)
                putNull("last_interaction_time")
                put("details_loaded", 1)
            }
            db.insertOrThrow("characters", null, characterValues)
            RelationalNodeCodec.flatten(data).forEach { row -> insertCharacterNode(db, id, row) }
            (data["tags"] as? List<*>)?.forEachIndexed { tagPosition, tag ->
                val text = tag?.toString()?.takeIf { it.isNotBlank() } ?: return@forEachIndexed
                db.execSQL(
                    "INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)",
                    arrayOf<Any>(id, tagPosition, text),
                )
            }

            val chatId = java.util.UUID.randomUUID().toString()
            val chatData = linkedMapOf<String, Any?>(
                "name" to "Chat 1",
                "note" to "",
                "localLore" to emptyList<Any?>(),
                "fmIndex" to -1,
            )
            val chatValues = ContentValues().apply {
                put("id", chatId)
                put("character_id", id)
                put("position", 0)
                put("name", "Chat 1")
                put("note", "")
                putNull("folder_id")
                putNull("last_message_time")
                put("messages_loaded", 0)
            }
            db.insertOrThrow("chats", null, chatValues)
            RelationalNodeCodec.flatten(chatData).forEach { row -> insertChatNode(db, chatId, row) }

            val nextRevision = revision + 1
            db.execSQL(
                "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
                arrayOf(nextRevision),
            )
            db.execSQL(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'android:character-import', datetime('now'))",
                arrayOf(nextRevision),
            )
            db.setTransactionSuccessful()
            CharacterSummary(id = id, name = payload.name, image = imageRef)
        } catch (error: Throwable) {
            imageFile?.delete()
            throw error
        } finally {
            db.endTransaction()
        }
    }

    override suspend fun updateGenerationSettings(settings: GenerationSettings): Long = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val revision = currentRevision(db)
            @Suppress("UNCHECKED_CAST")
            val existingGoogle = (loadNodeValue(
                db,
                "setting_extension_nodes",
                "setting_key = ?",
                arrayOf("google"),
            ) as? Map<String, Any?>)?.toMutableMap() ?: mutableMapOf()
            existingGoogle["accessToken"] = settings.googleApiKey

            val rootUpdates = linkedMapOf<String, Any?>(
                "username" to settings.username,
                "openAIKey" to settings.openAIKey,
                "claudeAPIKey" to settings.claudeAPIKey,
                "openrouterKey" to settings.openrouterKey,
                "google" to existingGoogle,
                "autofillRequestUrl" to settings.autofillRequestUrl,
            )
            rootUpdates.forEach { (key, value) -> writeSetting(db, key, value) }

            val presetId = loadActivePresetId(db)
            val preset = presetId?.let { loadPresetRecord(db, it) }
            if (presetId != null && preset != null) {
                applyEditablePresetSettings(preset.data, settings)
                writePresetRecord(db, presetId, preset.data)
            } else {
                val modelUpdates = editablePresetSettings(settings)
                modelUpdates.forEach { (key, value) -> writeSetting(db, key, value) }
            }

            val nextRevision = revision + 1
            db.execSQL(
                "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
                arrayOf(nextRevision),
            )
            db.execSQL(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'android:generation-settings', datetime('now'))",
                arrayOf(nextRevision),
            )
            db.setTransactionSuccessful()
            nextRevision
        } finally {
            db.endTransaction()
        }
    }

    override suspend fun createChat(characterId: String, name: String): ChatSummary = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val revision = currentRevision(db)
            val position = db.rawQuery(
                "SELECT COUNT(*) FROM chats WHERE character_id = ?",
                arrayOf(characterId),
            ).use { it.moveToFirst(); it.getInt(0) }
            val id = java.util.UUID.randomUUID().toString()
            val data = linkedMapOf<String, Any?>(
                "name" to name,
                "note" to "",
                "localLore" to emptyList<Any?>(),
                "fmIndex" to -1,
            )
            val values = ContentValues().apply {
                put("id", id)
                put("character_id", characterId)
                put("position", position)
                put("name", name)
                put("note", "")
                putNull("folder_id")
                putNull("last_message_time")
                put("messages_loaded", 0)
            }
            db.insertOrThrow("chats", null, values)
            RelationalNodeCodec.flatten(data).forEach { row -> insertChatNode(db, id, row) }
            val nextRevision = revision + 1
            db.execSQL(
                "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
                arrayOf(nextRevision),
            )
            db.execSQL(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'android:chat-create', datetime('now'))",
                arrayOf(nextRevision),
            )
            db.setTransactionSuccessful()
            ChatSummary(id = id, characterId = characterId, name = name)
        } finally {
            db.endTransaction()
        }
    }

    override suspend fun loadChatPromptContext(chatId: String): ChatPromptContext = withContext(Dispatchers.IO) {
        @Suppress("UNCHECKED_CAST")
        val chat = loadNodeValue(
            helper.readableDatabase,
            "chat_extension_nodes",
            "chat_id = ?",
            arrayOf(chatId),
        ) as? Map<String, Any?> ?: emptyMap()
        val scriptState = (chat["scriptstate"] as? Map<*, *>)
            ?.entries
            ?.associate { (key, value) -> key.toString().removePrefix("$") to value?.toString().orEmpty() }
            ?: emptyMap()
        ChatPromptContext(
            localLore = loreEntriesFromValue(chat["localLore"]),
            greetingIndex = (chat["fmIndex"] as? Number)?.toInt() ?: -1,
            variables = scriptState,
        )
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

    override suspend fun loadAllChatMessages(chatId: String): List<MessageRecord> = withContext(Dispatchers.IO) {
        val db = helper.readableDatabase
        val messages = mutableListOf<MessageRecord>()
        db.rawQuery(
            "SELECT id, role, content_text, sender_name, sent_time FROM messages WHERE chat_id = ? ORDER BY position",
            arrayOf(chatId),
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
        messages
    }

    override suspend fun commitPreparedTurn(
        characterId: String,
        chatId: String,
        chatPosition: Int,
        messages: List<PositionedMessage>,
        variables: Map<String, String>,
        messageManifest: List<String>?,
        characterPosition: Int,
        runtimePatch: RuntimeStatePatch,
    ): Long = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val belongsToCharacter = db.rawQuery(
                "SELECT 1 FROM chats WHERE id = ? AND character_id = ?",
                arrayOf(chatId, characterId),
            ).use { it.moveToFirst() }
            require(belongsToCharacter) { "Chat $chatId does not belong to character $characterId" }

            val revision = currentRevision(db)
            @Suppress("UNCHECKED_CAST")
            val chatData = (loadNodeValue(
                db,
                "chat_extension_nodes",
                "chat_id = ?",
                arrayOf(chatId),
            ) as? Map<String, Any?>)?.toMutableMap() ?: linkedMapOf()
            val scriptState = (chatData["scriptstate"] as? Map<*, *>)
                ?.entries
                ?.associateTo(linkedMapOf<String, Any?>()) { (key, value) -> key.toString() to value }
                ?: linkedMapOf()
            variables.forEach { (key, value) -> scriptState["$$key"] = value }
            chatData["scriptstate"] = scriptState
            runtimePatch.authorNote?.let { note ->
                chatData["note"] = note
                db.execSQL("UPDATE chats SET note = ? WHERE id = ?", arrayOf(note, chatId))
            }
            db.delete("chat_extension_nodes", "chat_id = ?", arrayOf(chatId))
            RelationalNodeCodec.flatten(chatData).forEach { row -> insertChatNode(db, chatId, row) }

            if (runtimePatch.hasCharacterChanges) {
                @Suppress("UNCHECKED_CAST")
                val characterData = (loadNodeValue(
                    db, "character_extension_nodes", "character_id = ?", arrayOf(characterId),
                ) as? Map<String, Any?>)?.toMutableMap()
                    ?: error("Character relational data is missing: $characterId")
                runtimePatch.characterDescription?.let { characterData["desc"] = it }
                runtimePatch.replaceGlobalNote?.let { characterData["replaceGlobalNote"] = it }
                db.delete("character_extension_nodes", "character_id = ?", arrayOf(characterId))
                RelationalNodeCodec.flatten(characterData).forEach { row -> insertCharacterNode(db, characterId, row) }
                db.execSQL(
                    "UPDATE characters SET modification_time = ?, updated_at = datetime('now') WHERE id = ?",
                    arrayOf<Any?>(System.currentTimeMillis(), characterId),
                )
            }

            if (messageManifest != null) {
                if (messageManifest.isEmpty()) {
                    db.delete("messages", "chat_id = ?", arrayOf(chatId))
                } else {
                    val placeholders = messageManifest.joinToString(",") { "?" }
                    db.delete(
                        "messages",
                        "chat_id = ? AND id NOT IN ($placeholders)",
                        (listOf(chatId) + messageManifest).toTypedArray(),
                    )
                }
            }
            messages.forEach { positioned ->
                writeMessage(db, chatId, positioned.position, positioned.message)
            }
            val latestTime = db.rawQuery(
                "SELECT sent_time FROM messages WHERE chat_id = ? ORDER BY position DESC LIMIT 1",
                arrayOf(chatId),
            ).use { cursor -> if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null }
            db.execSQL(
                "UPDATE chats SET last_message_time = ?, updated_at = datetime('now') WHERE id = ?",
                arrayOf<Any?>(latestTime, chatId),
            )

            val nextRevision = revision + 1
            db.execSQL(
                "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
                arrayOf(nextRevision),
            )
            db.execSQL(
                "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', 'android:chat-runtime', datetime('now'))",
                arrayOf(nextRevision),
            )
            db.setTransactionSuccessful()
            nextRevision
        } finally {
            db.endTransaction()
        }
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
            writeMessage(db, chatId, position, message)
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

    private fun writeMessage(db: SQLiteDatabase, chatId: String, position: Int, message: MessageRecord) {
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
    }

    private fun writeSetting(db: SQLiteDatabase, key: String, value: Any?) {
        val rows = RelationalNodeCodec.flatten(value)
        val root = rows.first()
        val values = ContentValues().apply {
            put("key", key)
            put("domain", settingDomain(key))
            put("value_type", root.valueType)
            if (root.textValue == null) putNull("text_value") else put("text_value", root.textValue)
            if (root.encodedTextValue == null) putNull("encoded_text_value") else put("encoded_text_value", root.encodedTextValue)
            if (root.numberValue == null) putNull("number_value") else put("number_value", root.numberValue)
            if (root.booleanValue == null) putNull("boolean_value") else put("boolean_value", root.booleanValue)
        }
        db.insertWithOnConflict("system_settings", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        db.delete("setting_extension_nodes", "setting_key = ?", arrayOf(key))
        rows.forEach { row -> insertSettingNode(db, key, row) }
    }

    private fun settingDomain(key: String): String = when (key) {
        "aiModel", "temperature", "maxResponse" -> "model"
        "openAIKey", "proxyKey", "forceReplaceUrl", "openrouterKey", "claudeAPIKey" -> "provider"
        else -> "account-sync-compatibility"
    }

    private data class GenerationState(
        val settings: GenerationSettings,
        val activePresetId: String?,
        val activePresetName: String?,
    )

    private data class PresetRecord(
        val name: String,
        val data: MutableMap<String, Any?>,
    )

    private fun loadGenerationState(db: SQLiteDatabase): GenerationState {
        val values = linkedMapOf<String, Any?>()
        for (key in GenerationSettingsMapper.keys) {
            values[key] = loadNodeValue(
                db,
                "setting_extension_nodes",
                "setting_key = ?",
                arrayOf(key),
            )
        }
        val base = GenerationSettingsMapper.fromMap(values)
        val presetId = loadActivePresetId(db)
        val preset = presetId?.let { loadPresetRecord(db, it) }
        return GenerationState(
            settings = preset?.let { GenerationSettingsMapper.applyPreset(base, it.data) } ?: base,
            activePresetId = presetId?.takeIf { preset != null },
            activePresetName = preset?.name,
        )
    }

    private fun loadActivePresetId(db: SQLiteDatabase): String? = loadNodeValue(
        db,
        "setting_extension_nodes",
        "setting_key = ?",
        arrayOf("activeBotPresetId"),
    )?.toString()?.takeIf { it.isNotBlank() }

    private fun loadPresetRecord(db: SQLiteDatabase, presetId: String): PresetRecord? = db.rawQuery(
        "SELECT name, data FROM bot_presets WHERE preset_id = ?",
        arrayOf(presetId),
    ).use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val data = jsonValue(JSONObject(cursor.getString(1))) as? Map<*, *> ?: return@use null
        val mutable = linkedMapOf<String, Any?>()
        data.forEach { (key, value) -> if (key != null) mutable[key.toString()] = value }
        PresetRecord(cursor.getString(0).orEmpty(), mutable)
    }

    private fun editablePresetSettings(settings: GenerationSettings): LinkedHashMap<String, Any?> = linkedMapOf(
        "aiModel" to settings.aiModel,
        "maxContext" to settings.maxContext,
        "maxResponse" to settings.maxResponse,
        "temperature" to settings.temperature * 100.0,
        "top_p" to settings.topP,
        "proxyKey" to settings.proxyKey,
        "forceReplaceUrl" to settings.forceReplaceUrl,
        "proxyRequestModel" to settings.proxyRequestModel,
        "customProxyRequestModel" to settings.customProxyRequestModel,
        "openrouterRequestModel" to settings.openrouterRequestModel,
    )

    private fun applyEditablePresetSettings(data: MutableMap<String, Any?>, settings: GenerationSettings) {
        editablePresetSettings(settings).forEach { (key, value) ->
            if (key == "top_p" && value == null) data.remove(key) else data[key] = value
        }
    }

    private fun writePresetRecord(db: SQLiteDatabase, presetId: String, data: Map<String, Any?>) {
        val serialized = toJsonValue(data).toString()
        val values = ContentValues().apply {
            put("name", data["name"]?.toString().orEmpty())
            put("image", data["image"]?.toString().orEmpty())
            put("api_type", data["apiType"]?.toString().orEmpty())
            put("ai_model", data["aiModel"]?.toString().orEmpty())
            put("data", serialized)
            put("content_hash", presetContentHash(serialized))
        }
        val changed = db.update("bot_presets", values, "preset_id = ?", arrayOf(presetId))
        check(changed == 1) { "Active bot preset disappeared while saving: $presetId" }
        db.execSQL("UPDATE bot_presets SET updated_at = datetime('now') WHERE preset_id = ?", arrayOf(presetId))
    }

    private fun presetContentHash(serialized: String): String {
        var hash = 2166136261u.toInt()
        serialized.forEach { char ->
            hash = hash xor char.code
            hash *= 16777619
        }
        return "${serialized.length}-${hash.toUInt().toString(16)}"
    }

    private fun toJsonValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().apply {
            value.forEach { (key, child) -> if (key != null) put(key.toString(), toJsonValue(child)) }
        }
        is Iterable<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it)) } }
        is Array<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it)) } }
        else -> value
    }

    private fun jsonValue(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> linkedMapOf<String, Any?>().apply {
            val keys = value.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                put(key, jsonValue(value.opt(key)))
            }
        }
        is JSONArray -> buildList {
            for (index in 0 until value.length()) add(jsonValue(value.opt(index)))
        }
        else -> value
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

    private fun insertSettingNode(db: SQLiteDatabase, key: String, row: RelationalNodeRow) {
        val values = ContentValues().apply {
            put("setting_key", key)
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
        db.insertOrThrow("setting_extension_nodes", null, values)
    }

    private fun insertCharacterNode(db: SQLiteDatabase, characterId: String, row: RelationalNodeRow) {
        val values = ContentValues().apply {
            put("character_id", characterId)
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
        db.insertOrThrow("character_extension_nodes", null, values)
    }

    private fun insertChatNode(db: SQLiteDatabase, chatId: String, row: RelationalNodeRow) {
        val values = ContentValues().apply {
            put("chat_id", chatId)
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
        db.insertOrThrow("chat_extension_nodes", null, values)
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
